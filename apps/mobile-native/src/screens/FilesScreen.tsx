import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {
  MobileApi,
  NativeJob,
  NativeSessionSummary,
  NativeWorkspaceFileEntry,
  NativeWorkspaceFileListResult,
  NativeWorkspaceFileReadResult,
} from '../api/mobileApi';
import { useAsyncResource } from '../state/asyncResource';
import { ResourceErrorBanner, ResourceHeader, ResourceState } from '../ui/ResourceState';
import { colors } from '../ui/theme';
import { pickSessionImage } from './nativeImagePicker';

type FilesApi = Pick<
  MobileApi,
  | 'getSessionSync'
  | 'listSessionFiles'
  | 'listSessions'
  | 'mkdirSessionDirectory'
  | 'readSessionFile'
  | 'renameSessionFile'
  | 'uploadSessionFile'
  | 'writeSessionFile'
  | 'createSessionFile'
>;

type FileActionKind = 'create' | 'directory' | 'rename' | null;

export function FilesScreen({
  api,
  csrfToken,
  canEdit = false,
  requestedTarget = null,
  onRequestedTargetHandled,
  onRequestError,
}: {
  api: FilesApi;
  csrfToken: string;
  canEdit?: boolean;
  requestedTarget?: { sessionId: string; path: string } | null;
  onRequestedTargetHandled?(target: { sessionId: string; path: string }): void;
  onRequestError?(error: unknown): void;
}) {
  const loadSessions = useCallback(async () => {
    const payload = await api.listSessions();
    return payload.items.filter((session) => Boolean(session.workspace_root));
  }, [api]);
  const sessionResource = useAsyncResource(loadSessions, { onError: onRequestError });
  const sessions = sessionResource.data ?? [];
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [path, setPath] = useState('.');
  const [preview, setPreview] = useState<NativeWorkspaceFileReadResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [fileQuery, setFileQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionKind, setActionKind] = useState<FileActionKind>(null);
  const [actionPath, setActionPath] = useState('');
  const [actionText, setActionText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.session_id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );
  const previewSession = useMemo(
    () => selectedSession
      ?? (requestedTarget ? sessions.find((session) => session.session_id === requestedTarget.sessionId) ?? null : null),
    [requestedTarget, selectedSession, sessions],
  );

  useEffect(() => {
    if (sessions.length === 0) {
      setSelectedSessionId(null);
      return;
    }
    if (!selectedSessionId || !sessions.some((session) => session.session_id === selectedSessionId)) {
      setSelectedSessionId(sessions[0]?.session_id ?? null);
      setPath('.');
    }
  }, [selectedSessionId, sessions]);

  const loadFiles = useCallback(async () => {
    if (!selectedSession) return emptyFileList(path);
    const response = await api.listSessionFiles(selectedSession.session_id, { path }, csrfToken);
    const job = await waitForSessionJob(api, selectedSession.session_id, response.job.job_id);
    return parseJobResult<NativeWorkspaceFileListResult>(job, '文件列表读取失败');
  }, [api, csrfToken, path, selectedSession]);
  const fileResource = useAsyncResource(loadFiles, {
    onError: onRequestError,
    resetKey: `${selectedSessionId ?? 'none'}:${path}`,
  });
  const entries = fileResource.data?.entries ?? [];
  const normalizedFileQuery = fileQuery.trim().toLocaleLowerCase();
  const hiddenEntryCount = entries.filter((entry) => entry.name.startsWith('.')).length;
  const filteredEntries = useMemo(() => entries.filter((entry) => {
    if (!showHidden && entry.name.startsWith('.')) return false;
    if (!normalizedFileQuery) return true;
    return [entry.name, entry.path, entry.extension, entry.preview_capability]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(normalizedFileQuery);
  }), [entries, normalizedFileQuery, showHidden]);

  async function openEntry(entry: NativeWorkspaceFileEntry) {
    if (!selectedSession) return;
    if (entry.kind === 'directory') {
      setPath(entry.path);
      return;
    }
    await openFilePath(selectedSession, entry.path);
  }

  async function openFilePath(session: NativeSessionSummary, filePath: string) {
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const response = await api.readSessionFile(
        session.session_id,
        { path: filePath, max_bytes: 5_000_000 },
        csrfToken,
      );
      const job = await waitForSessionJob(api, session.session_id, response.job.job_id);
      const result = parseJobResult<NativeWorkspaceFileReadResult>(job, '文件读取失败');
      setPreview(result);
      setEditorText(result.text ?? '');
      setEditing(false);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '文件读取失败');
      onRequestError?.(error);
    } finally {
      setPreviewBusy(false);
    }
  }

  useEffect(() => {
    if (!requestedTarget || sessions.length === 0) return;
    if (fileResource.loading || fileResource.refreshing) return;
    const targetSession = sessions.find((session) => session.session_id === requestedTarget.sessionId);
    if (!targetSession) return;
    const relativePath = toRelativeWorkspacePath(targetSession.workspace_root, requestedTarget.path);
    if (!relativePath) return;
    setSelectedSessionId(targetSession.session_id);
    setPath(parentPath(relativePath));
    void openFilePath(targetSession, relativePath).finally(() => {
      onRequestedTargetHandled?.(requestedTarget);
    });
  }, [fileResource.loading, fileResource.refreshing, onRequestedTargetHandled, requestedTarget, sessions]);

  if (preview && previewSession) {
    return (
      <FilePreview
        canEdit={canEdit}
        editing={editing}
        editorText={editorText}
        error={previewError}
        file={preview}
        onBack={() => {
          setPreview(null);
          setEditing(false);
          setPreviewError(null);
        }}
        onChangeText={setEditorText}
        onEdit={() => setEditing(true)}
        onSave={() => void saveFile(previewSession)}
        saving={previewBusy}
      />
    );
  }

  async function saveFile(session: NativeSessionSummary) {
    if (!preview || previewBusy || !canEdit) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const response = await api.writeSessionFile(
        session.session_id,
        {
          path: preview.path,
          text: editorText,
          expected_modified_at: preview.modified_at ?? null,
        },
        csrfToken,
      );
      const job = await waitForSessionJob(api, session.session_id, response.job.job_id);
      const result = parseJobResult<NativeWorkspaceFileReadResult>(job, '文件保存失败');
      setPreview(result);
      setEditorText(result.text ?? editorText);
      setEditing(false);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '文件保存失败');
      onRequestError?.(error);
    } finally {
      setPreviewBusy(false);
    }
  }

  function startFileAction(kind: Exclude<FileActionKind, null>, entry?: NativeWorkspaceFileEntry) {
    setActionsOpen(true);
    setActionKind(kind);
    setActionError(null);
    setActionText('');
    setActionPath(entry?.path ?? '');
  }

  function closeFileAction() {
    if (actionBusy) return;
    setActionKind(null);
    setActionError(null);
    setActionPath('');
    setActionText('');
  }

  async function completeFileMutation(response: { job: NativeJob }) {
    if (!selectedSession) return;
    await waitForSessionJob(api, selectedSession.session_id, response.job.job_id);
    await fileResource.reload();
  }

  async function submitFileAction() {
    if (!selectedSession || !actionKind || !actionPath.trim() || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (actionKind === 'create') {
        await completeFileMutation(await api.createSessionFile(
          selectedSession.session_id,
          { path: actionPath.trim(), text: actionText, overwrite: false },
          csrfToken,
        ));
      } else if (actionKind === 'directory') {
        await completeFileMutation(await api.mkdirSessionDirectory(
          selectedSession.session_id,
          { path: actionPath.trim() },
          csrfToken,
        ));
      } else {
        const sourcePath = actionPath.trim();
        const newPath = actionText.trim();
        if (!newPath) throw new Error('请输入新的文件路径');
        await completeFileMutation(await api.renameSessionFile(
          selectedSession.session_id,
          { path: sourcePath, new_path: newPath },
          csrfToken,
        ));
      }
      closeFileAction();
    } catch (error) {
      const message = error instanceof Error ? error.message : '文件操作失败';
      setActionError(message);
      onRequestError?.(error);
    } finally {
      setActionBusy(false);
    }
  }

  async function uploadImageToCurrentDirectory() {
    if (!selectedSession || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const image = await pickSessionImage();
      if (!image) return;
      await completeFileMutation(await api.uploadSessionFile(
        selectedSession.session_id,
        {
          path,
          filename: image.filename,
          content_type: image.content_type,
          data_base64: image.data_base64,
          overwrite: false,
        },
        csrfToken,
      ));
      setActionsOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片上传失败';
      setActionError(message);
      onRequestError?.(error);
    } finally {
      setActionBusy(false);
    }
  }

  const loadingSessions = sessionResource.loading || (sessionResource.error !== null && sessionResource.data === null);
  const loadingFiles = fileResource.loading || (fileResource.error !== null && fileResource.data === null);
  return (
    <View style={styles.screen}>
      <ResourceHeader
        eyebrow="WORKSPACE"
        onRefresh={async () => {
          await sessionResource.reload();
          await fileResource.reload();
        }}
        refreshLabel="刷新文件"
        refreshing={sessionResource.refreshing || fileResource.refreshing}
        title="文件"
      />
      {loadingSessions ? (
        <ResourceState
          empty={false}
          emptyText=""
          error={sessionResource.error}
          failureTitle="工作区加载失败"
          loading={sessionResource.loading}
          loadingText="正在加载工作区"
          onRetry={sessionResource.reload}
          retryLabel="重试加载工作区"
        />
      ) : sessions.length === 0 ? (
        <ResourceState
          empty
          emptyText="暂无带工作目录的会话"
          error={null}
          failureTitle=""
          loading={false}
          loadingText=""
          onRetry={sessionResource.reload}
          retryLabel="刷新工作区"
        />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={styles.sessionRow}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {sessions.map((session) => {
              const selected = session.session_id === selectedSessionId;
              return (
                <Pressable
                  accessibilityLabel={`选择工作区 ${session.title}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={session.session_id}
                  onPress={() => {
                    setSelectedSessionId(session.session_id);
                    setPath('.');
                  }}
                  style={({ pressed }) => [
                    styles.sessionChip,
                    selected && styles.sessionChipSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text numberOfLines={1} style={[styles.sessionChipText, selected && styles.sessionChipTextSelected]}>
                    {session.title}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.pathBar}>
            <Pressable
              accessibilityLabel="返回上级目录"
              accessibilityRole="button"
              disabled={path === '.'}
              onPress={() => setPath(parentPath(path))}
              style={({ pressed }) => [styles.pathButton, pressed && styles.pressed, path === '.' && styles.disabled]}
            >
              <Ionicons color={colors.text} name="arrow-up" size={18} />
            </Pressable>
            <View style={styles.pathCopy}>
              <View style={styles.breadcrumbRow}>
                {breadcrumbs(path).map((crumb, index) => (
                  <Pressable
                    accessibilityLabel={`进入目录 ${crumb.label}`}
                    accessibilityRole="button"
                    disabled={crumb.path === path}
                    key={`${crumb.path}-${index}`}
                    onPress={() => setPath(crumb.path)}
                    style={({ pressed }) => [styles.breadcrumbButton, pressed && styles.pressed]}
                  >
                    <Text numberOfLines={1} style={[styles.breadcrumbText, crumb.path === path && styles.breadcrumbTextCurrent]}>
                      {crumb.label}
                    </Text>
                    {index < breadcrumbs(path).length - 1 ? <Text style={styles.breadcrumbDivider}>/</Text> : null}
                  </Pressable>
                ))}
              </View>
              <Text numberOfLines={1} style={styles.workspaceRoot}>{selectedSession?.workspace_root}</Text>
            </View>
            {canEdit ? (
              <Pressable
                accessibilityLabel="文件操作"
                accessibilityRole="button"
                onPress={() => setActionsOpen((current) => !current)}
                style={({ pressed }) => [styles.pathButton, pressed && styles.pressed]}
              >
                <Ionicons color={colors.accent} name="add" size={21} />
              </Pressable>
            ) : null}
          </View>
          {canEdit && actionsOpen ? (
            <View style={styles.actionPanel}>
              {!actionKind ? (
                <View style={styles.actionChoices}>
                  <Pressable accessibilityLabel="新建文本文件" accessibilityRole="button" onPress={() => startFileAction('create')} style={({ pressed }) => [styles.actionChoice, pressed && styles.pressed]}>
                    <Ionicons color={colors.accent} name="document-text-outline" size={18} />
                    <Text style={styles.actionChoiceText}>新建文本</Text>
                  </Pressable>
                  <Pressable accessibilityLabel="新建文件夹" accessibilityRole="button" onPress={() => startFileAction('directory')} style={({ pressed }) => [styles.actionChoice, pressed && styles.pressed]}>
                    <Ionicons color={colors.accent} name="folder-open-outline" size={18} />
                    <Text style={styles.actionChoiceText}>新建目录</Text>
                  </Pressable>
                  <Pressable accessibilityLabel="上传图片到当前目录" accessibilityRole="button" disabled={actionBusy} onPress={() => void uploadImageToCurrentDirectory()} style={({ pressed }) => [styles.actionChoice, actionBusy && styles.disabled, pressed && styles.pressed]}>
                    <Ionicons color={colors.accent} name="image-outline" size={18} />
                    <Text style={styles.actionChoiceText}>{actionBusy ? '上传中' : '上传图片'}</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.actionForm}>
                  <Text style={styles.actionTitle}>{actionKind === 'create' ? '新建文本文件' : actionKind === 'directory' ? '新建目录' : '重命名'}</Text>
                  <TextInput
                    accessibilityLabel={actionKind === 'rename' ? '原文件路径' : actionKind === 'create' ? '新文件路径' : '新目录路径'}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!actionBusy}
                    onChangeText={setActionPath}
                    placeholder={actionKind === 'directory' ? '例如 reports' : '例如 notes.md'}
                    placeholderTextColor={colors.muted}
                    style={styles.actionInput}
                    value={actionPath}
                  />
                  {actionKind === 'create' ? (
                    <TextInput
                      accessibilityLabel="新文件内容"
                      editable={!actionBusy}
                      multiline
                      onChangeText={setActionText}
                      placeholder="可留空，之后再编辑"
                      placeholderTextColor={colors.muted}
                      style={[styles.actionInput, styles.actionTextArea]}
                      textAlignVertical="top"
                      value={actionText}
                    />
                  ) : null}
                  {actionKind === 'rename' ? (
                    <TextInput
                      accessibilityLabel="新文件路径"
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!actionBusy}
                      onChangeText={setActionText}
                      placeholder="新的相对路径"
                      placeholderTextColor={colors.muted}
                      style={styles.actionInput}
                      value={actionText}
                    />
                  ) : null}
                  {actionError ? <Text accessibilityRole="alert" style={styles.actionError}>{actionError}</Text> : null}
                  <View style={styles.actionFormButtons}>
                    <Pressable accessibilityLabel="取消文件操作" accessibilityRole="button" disabled={actionBusy} onPress={closeFileAction} style={({ pressed }) => [styles.cancelAction, pressed && styles.pressed]}>
                      <Text style={styles.cancelActionText}>取消</Text>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={actionKind === 'create' ? '确认创建文件' : actionKind === 'directory' ? '确认创建目录' : '确认重命名'}
                      accessibilityRole="button"
                      disabled={actionBusy || !actionPath.trim() || (actionKind === 'rename' && !actionText.trim())}
                      onPress={() => void submitFileAction()}
                      style={({ pressed }) => [styles.confirmAction, (actionBusy || !actionPath.trim() || (actionKind === 'rename' && !actionText.trim())) && styles.disabled, pressed && styles.pressed]}
                    >
                      {actionBusy ? <ActivityIndicator color={colors.surface} size="small" /> : null}
                      <Text style={styles.confirmActionText}>{actionBusy ? '处理中' : '确认'}</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          ) : null}
          <View style={styles.fileSearchRow}>
            <Ionicons color={colors.muted} name="search-outline" size={18} />
            <TextInput accessibilityLabel="搜索当前目录文件" autoCapitalize="none" autoCorrect={false} onChangeText={setFileQuery} placeholder="搜索当前目录" placeholderTextColor={colors.muted} style={styles.fileSearchInput} value={fileQuery} />
            {hiddenEntryCount > 0 ? (
              <Pressable accessibilityLabel={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'} accessibilityRole="button" onPress={() => setShowHidden((current) => !current)} style={({ pressed }) => [styles.hiddenToggle, pressed && styles.pressed]}>
                <Text style={styles.hiddenToggleText}>{showHidden ? '隐藏' : `隐藏项 ${hiddenEntryCount}`}</Text>
              </Pressable>
            ) : null}
          </View>
          {previewError ? (
            <View style={styles.inlineError}>
              <Text style={styles.inlineErrorText}>{previewError}</Text>
            </View>
          ) : null}
          {previewBusy ? (
            <View style={styles.previewBusy}>
              <ActivityIndicator color={colors.accent} size="small" />
              <Text style={styles.mutedText}>正在读取文件</Text>
            </View>
          ) : null}
          {loadingFiles ? (
            <ResourceState
              empty={false}
              emptyText=""
              error={fileResource.error}
              failureTitle="文件列表加载失败"
              loading={fileResource.loading}
              loadingText="正在读取文件列表"
              onRetry={fileResource.reload}
              retryLabel="重试读取文件列表"
            />
          ) : (
            <FlatList
              contentContainerStyle={styles.fileList}
              data={filteredEntries}
              keyExtractor={(entry) => entry.path}
              ListEmptyComponent={<Text style={styles.emptyText}>{normalizedFileQuery ? '没有匹配的文件' : '当前目录为空'}</Text>}
              ListHeaderComponent={fileResource.error ? (
                <ResourceErrorBanner
                  error={fileResource.error}
                  onRetry={fileResource.reload}
                  retryLabel="重试读取文件列表"
                />
              ) : null}
              refreshControl={(
                <RefreshControl
                  colors={[colors.accent]}
                  onRefresh={() => void fileResource.reload()}
                  refreshing={fileResource.refreshing}
                  tintColor={colors.accent}
                />
              )}
              renderItem={({ item }) => (
                <FileRow
                  canEdit={canEdit}
                  entry={item}
                  onPress={() => void openEntry(item)}
                  onRename={() => startFileAction('rename', item)}
                />
              )}
            />
          )}
        </>
      )}
    </View>
  );
}

function FileRow({
  entry,
  canEdit,
  onPress,
  onRename,
}: {
  entry: NativeWorkspaceFileEntry;
  canEdit: boolean;
  onPress(): void;
  onRename(): void;
}) {
  const directory = entry.kind === 'directory';
  return (
    <Pressable
      accessibilityLabel={`${directory ? '打开目录' : '打开文件'} ${entry.name}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.fileRow, pressed && styles.pressed]}
    >
      <View style={[styles.fileIcon, directory && styles.directoryIcon]}>
        <Ionicons
          color={directory ? colors.accent : colors.muted}
          name={directory ? 'folder-outline' : fileIcon(entry)}
          size={21}
        />
      </View>
      <View style={styles.fileCopy}>
        <Text numberOfLines={1} style={styles.fileName}>{entry.name}</Text>
        <Text numberOfLines={1} style={styles.fileMetadata}>
          {directory ? '目录' : `${fileKindLabel(entry)} · ${formatFileSize(entry.size_bytes)}`}
        </Text>
      </View>
      {canEdit ? (
        <Pressable accessibilityLabel={`重命名 ${entry.name}`} accessibilityRole="button" onPress={onRename} style={({ pressed }) => [styles.fileMoreButton, pressed && styles.pressed]}>
          <Ionicons color={colors.muted} name="ellipsis-horizontal" size={19} />
        </Pressable>
      ) : <Ionicons color={colors.muted} name="chevron-forward" size={18} />}
    </Pressable>
  );
}

function FilePreview({
  file,
  canEdit,
  editing,
  editorText,
  saving,
  error,
  onBack,
  onEdit,
  onChangeText,
  onSave,
}: {
  file: NativeWorkspaceFileReadResult;
  canEdit: boolean;
  editing: boolean;
  editorText: string;
  saving: boolean;
  error: string | null;
  onBack(): void;
  onEdit(): void;
  onChangeText(value: string): void;
  onSave(): void;
}) {
  const textFile = (file.preview_kind ?? 'text') === 'text';
  const imageUri = file.preview_kind === 'image' && file.data_base64
    ? `data:${file.content_type};base64,${file.data_base64}`
    : null;
  return (
    <View style={styles.screen}>
      <View style={styles.previewHeader}>
        <Pressable
          accessibilityLabel="返回文件列表"
          accessibilityRole="button"
          onPress={onBack}
          style={({ pressed }) => [styles.pathButton, pressed && styles.pressed]}
        >
          <Ionicons color={colors.text} name="arrow-back" size={20} />
        </Pressable>
        <View style={styles.previewHeaderCopy}>
          <Text numberOfLines={1} style={styles.previewTitle}>{file.filename}</Text>
          <Text numberOfLines={1} style={styles.fileMetadata}>{file.path}</Text>
        </View>
        {textFile && canEdit && !file.truncated && !editing ? (
          <Pressable
            accessibilityLabel="编辑文件"
            accessibilityRole="button"
            onPress={onEdit}
            style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}
          >
            <Ionicons color={colors.accent} name="create-outline" size={18} />
            <Text style={styles.editButtonText}>编辑</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.previewError}>{error}</Text> : null}
      {editing ? (
        <TextInput
          accessibilityLabel="文件内容"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={onChangeText}
          style={styles.editor}
          textAlignVertical="top"
          value={editorText}
        />
      ) : imageUri ? (
        <View style={styles.imageStage}>
          <Image resizeMode="contain" source={{ uri: imageUri }} style={styles.imagePreview} />
        </View>
      ) : textFile ? (
        <ScrollView contentContainerStyle={styles.textPreviewContent}>
          <Text selectable style={styles.textPreview}>{file.text || '文件为空'}</Text>
          {file.truncated ? <Text style={styles.truncatedText}>内容过大，当前仅显示前一部分</Text> : null}
        </ScrollView>
      ) : (
        <View style={styles.unsupportedPreview}>
          <Ionicons color={colors.muted} name="document-attach-outline" size={34} />
          <Text style={styles.mutedText}>{file.content_type || '当前文件可下载，但暂不支持原生预览'}</Text>
          <Text style={styles.fileMetadata}>{formatFileSize(file.size_bytes)}</Text>
        </View>
      )}
      {editing ? (
        <View style={styles.editorFooter}>
          <Pressable
            accessibilityLabel="保存文件"
            accessibilityRole="button"
            disabled={saving}
            onPress={onSave}
            style={({ pressed }) => [styles.saveButton, pressed && styles.pressed, saving && styles.disabled]}
          >
            {saving ? <ActivityIndicator color={colors.surface} size="small" /> : <Ionicons color={colors.surface} name="save-outline" size={18} />}
            <Text style={styles.saveButtonText}>{saving ? '正在保存' : '保存文件'}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

async function waitForSessionJob(
  api: Pick<MobileApi, 'getSessionSync'>,
  sessionId: string,
  jobId: string,
  attempts = 20,
  delayMs = 300,
): Promise<NativeJob> {
  let latest: NativeJob | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sync = await api.getSessionSync(sessionId);
    latest = sync.jobs.find((job) => job.job_id === jobId);
    if (latest && !['queued', 'running'].includes(latest.status)) return latest;
    if (attempt < attempts - 1) await delay(delayMs);
  }
  if (latest) return latest;
  throw new Error('Worker 尚未返回文件结果，请稍后刷新');
}

function parseJobResult<T>(job: NativeJob, fallbackMessage: string): T {
  if (job.status === 'failed') throw new Error(job.error_text || fallbackMessage);
  if (job.status !== 'succeeded') throw new Error('Worker 仍在处理，请稍后重试');
  if (!job.result_text) throw new Error(`${fallbackMessage}：结果为空`);
  try {
    return JSON.parse(job.result_text) as T;
  } catch {
    throw new Error(`${fallbackMessage}：结果格式无效`);
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function emptyFileList(path: string): NativeWorkspaceFileListResult {
  return { path, entries: [] };
}

function parentPath(path: string) {
  if (!path || path === '.') return '.';
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/') || '.';
}

function breadcrumbs(path: string): Array<{ label: string; path: string }> {
  if (!path || path === '.') return [{ label: '根目录', path: '.' }];
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const result: Array<{ label: string; path: string }> = [{ label: '根目录', path: '.' }];
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    result.push({ label: part, path: current });
  }
  return result;
}

function toRelativeWorkspacePath(workspaceRoot: string | undefined, filePath: string) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedRoot = (workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedRoot) return normalizedPath;
  if (!normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return normalizedPath;
  const relative = normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '');
  return relative || '.';
}

function formatFileSize(value?: number | null) {
  const bytes = Number(value ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileKindLabel(entry: NativeWorkspaceFileEntry) {
  if (entry.preview_capability === 'markdown') return 'Markdown';
  if (entry.preview_capability === 'image') return '图片';
  if (entry.preview_capability === 'audio') return '音频';
  if (entry.preview_capability === 'video') return '视频';
  if (entry.preview_capability === 'text') return '文本';
  return entry.extension?.toUpperCase() || '文件';
}

function fileIcon(entry: NativeWorkspaceFileEntry) {
  if (entry.preview_capability === 'image') return 'image-outline';
  if (entry.preview_capability === 'audio') return 'musical-notes-outline';
  if (entry.preview_capability === 'video') return 'videocam-outline';
  if (entry.preview_capability === 'markdown' || entry.preview_capability === 'text') return 'document-text-outline';
  return 'document-outline';
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.canvas, flex: 1 },
  sessionRow: { gap: 8, paddingBottom: 12, paddingHorizontal: 16 },
  sessionChip: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    justifyContent: 'center',
    maxWidth: 200,
    minHeight: 38,
    paddingHorizontal: 12,
  },
  sessionChipSelected: { backgroundColor: colors.surfaceMuted, borderColor: colors.accent },
  sessionChipText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  sessionChipTextSelected: { color: colors.accent, fontWeight: '700' },
  pathBar: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderTopColor: colors.border,
    borderBottomWidth: 1,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 11,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pathButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  pathCopy: { flex: 1, gap: 2 },
  breadcrumbRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap' },
  breadcrumbButton: { alignItems: 'center', flexDirection: 'row', maxWidth: 130 },
  breadcrumbText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  breadcrumbTextCurrent: { color: colors.text, fontWeight: '800' },
  breadcrumbDivider: { color: colors.muted, fontSize: 12, marginHorizontal: 3 },
  workspaceRoot: { color: colors.muted, fontSize: 11 },
  actionPanel: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  actionChoices: { flexDirection: 'row', gap: 8 },
  actionChoice: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flex: 1,
    gap: 5,
    justifyContent: 'center',
    minHeight: 62,
    paddingHorizontal: 5,
  },
  actionChoiceText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  actionForm: { gap: 9 },
  actionTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  actionInput: {
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    color: colors.text,
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 11,
  },
  actionTextArea: { minHeight: 92, paddingTop: 11 },
  actionError: { color: colors.danger, fontSize: 12, lineHeight: 18 },
  actionFormButtons: { flexDirection: 'row', gap: 9, justifyContent: 'flex-end' },
  cancelAction: { alignItems: 'center', justifyContent: 'center', minHeight: 42, paddingHorizontal: 14 },
  cancelActionText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  confirmAction: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 42,
    minWidth: 82,
    paddingHorizontal: 14,
  },
  confirmActionText: { color: colors.surface, fontSize: 13, fontWeight: '800' },
  fileSearchRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  fileSearchInput: { color: colors.text, flex: 1, fontSize: 14, minHeight: 34 },
  hiddenToggle: { backgroundColor: colors.surfaceMuted, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 6 },
  hiddenToggleText: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  fileList: { paddingBottom: 28, paddingHorizontal: 16, paddingTop: 10 },
  fileRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 11,
    minHeight: 66,
    paddingVertical: 9,
  },
  fileIcon: {
    alignItems: 'center',
    backgroundColor: colors.surfaceMuted,
    borderRadius: 7,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  directoryIcon: { backgroundColor: '#E8F1FD' },
  fileCopy: { flex: 1, gap: 4 },
  fileMoreButton: { alignItems: 'center', height: 40, justifyContent: 'center', width: 40 },
  fileName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  fileMetadata: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  previewBusy: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 18, paddingVertical: 9 },
  mutedText: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  inlineError: { backgroundColor: '#FEF3F2', paddingHorizontal: 18, paddingVertical: 9 },
  inlineErrorText: { color: colors.danger, fontSize: 13 },
  emptyText: { color: colors.muted, fontSize: 14, paddingTop: 48, textAlign: 'center' },
  previewHeader: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 11,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  previewHeaderCopy: { flex: 1, gap: 3 },
  previewTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  editButton: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 5,
    minHeight: 40,
    paddingHorizontal: 11,
  },
  editButtonText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  previewError: { backgroundColor: '#FEF3F2', color: colors.danger, fontSize: 13, padding: 12 },
  textPreviewContent: { padding: 18 },
  textPreview: { color: colors.text, fontFamily: 'monospace', fontSize: 14, lineHeight: 22 },
  truncatedText: { color: colors.danger, fontSize: 12, marginTop: 18 },
  editor: {
    backgroundColor: colors.surface,
    color: colors.text,
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 22,
    padding: 16,
  },
  editorFooter: { borderTopColor: colors.border, borderTopWidth: 1, padding: 12 },
  saveButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 7,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
  },
  saveButtonText: { color: colors.surface, fontSize: 14, fontWeight: '700' },
  imageStage: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 14 },
  imagePreview: { height: '100%', width: '100%' },
  unsupportedPreview: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center', padding: 32 },
  pressed: { opacity: 0.65 },
  disabled: { opacity: 0.42 },
});
