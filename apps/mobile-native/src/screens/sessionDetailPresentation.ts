import type { NativePermission, NativeTimelineItem } from '../api/mobileApi';

export interface NativeTimelineAttachment {
  filename: string;
  content_type: string;
  size_bytes: number | null;
  path?: string | null;
  url?: string | null;
}

export interface NativePermissionChoice {
  id: string;
  label: string;
  description?: string;
  questionId?: string;
  freeform?: boolean;
}

export interface NativePermissionQuestion {
  id: string;
  header: string;
  question: string;
  options: NativePermissionChoice[];
}

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function withOtherChoice(questionId: string, options: NativePermissionChoice[]) {
  const hasOther = options.some((option) => {
    const label = option.label.toLowerCase();
    return option.freeform || label === 'other' || label === '其他' || label.startsWith('其他：');
  });
  if (hasOther) return options;
  return [
    ...options,
    {
      id: `${questionId}:other`,
      label: '其他',
      description: '输入其他选择或补充要求',
      questionId,
      freeform: true,
    },
  ];
}

function parseChoice(
  value: unknown,
  index: number,
  questionId?: string,
): NativePermissionChoice | null {
  if (typeof value === 'string' || typeof value === 'number') {
    return {
      id: questionId ? `${questionId}:${index}` : String(value),
      label: String(value),
      questionId,
    };
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = textValue(record.id) || textValue(record.value) || (questionId ? `${questionId}:${index}` : String(index));
  const label = textValue(record.label) || textValue(record.title) || textValue(record.name) || textValue(record.value) || id;
  if (!label) return null;
  return {
    id,
    label,
    description: textValue(record.description) || undefined,
    questionId: textValue(record.question_id) || textValue(record.questionId) || questionId,
    freeform: record.freeform === true || record.isOther === true,
  };
}

export function permissionChoices(permission: NativePermission): NativePermissionChoice[] {
  const source =
    permission.actions?.choices ??
    permission.actions?.options ??
    permission.detail?.choices ??
    permission.detail?.options;
  if (Array.isArray(source)) {
    return source
      .map((value, index) => parseChoice(value, index))
      .filter((value): value is NativePermissionChoice => value !== null);
  }
  if (source && typeof source === 'object') {
    return Object.entries(source as Record<string, unknown>).map(([id, value]) => ({
      id,
      label: textValue(value) || id,
    }));
  }
  return [];
}

export function permissionQuestions(permission: NativePermission): NativePermissionQuestion[] {
  const source = permission.detail?.questions;
  if (Array.isArray(source)) {
    const questions = source.flatMap((value, index) => {
      if (!value || typeof value !== 'object') return [];
      const record = value as Record<string, unknown>;
      const id = textValue(record.id) || `question_${index + 1}`;
      const rawOptions = Array.isArray(record.options) ? record.options : [];
      const options = rawOptions
        .map((option, optionIndex) => parseChoice(option, optionIndex, id))
        .filter((option): option is NativePermissionChoice => option !== null);
      if (options.length === 0) return [];
      return [{
        id,
        header: textValue(record.header),
        question: textValue(record.question),
        options: withOtherChoice(id, options),
      }];
    });
    if (questions.length > 0) return questions;
  }

  const grouped = new Map<string, NativePermissionChoice[]>();
  for (const choice of permissionChoices(permission)) {
    if (!choice.questionId) continue;
    const choices = grouped.get(choice.questionId) ?? [];
    choices.push(choice);
    grouped.set(choice.questionId, choices);
  }
  return [...grouped.entries()].map(([id, options]) => ({
    id,
    header: id,
    question: '',
    options: withOtherChoice(id, options),
  }));
}

export function buildQuestionResponse(
  selected: Record<string, NativePermissionChoice>,
  freeform: Record<string, string>,
  note: string,
): Record<string, unknown> {
  const answers = Object.fromEntries(
    Object.entries(selected).map(([questionId, choice]) => {
      const freeformText = freeform[questionId]?.trim() ?? '';
      return [
        questionId,
        {
          choice: choice.id,
          label: choice.freeform && freeformText ? `其他：${freeformText}` : choice.label,
          ...(choice.freeform && freeformText ? { text: freeformText } : {}),
        },
      ];
    }),
  );
  const trimmedNote = note.trim();
  return { answers, ...(trimmedNote ? { note: trimmedNote } : {}) };
}

export function sortedTimeline(items: NativeTimelineItem[]): NativeTimelineItem[] {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(left.created_at);
    const rightTime = Date.parse(right.created_at);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.seq - right.seq;
  });
}

export function timelineAttachments(item: NativeTimelineItem): NativeTimelineAttachment[] {
  const sources = [
    item.payload?.attachments,
    item.payload?.input && typeof item.payload.input === 'object'
      ? (item.payload.input as Record<string, unknown>).attachments
      : null,
    item.payload?.detail && typeof item.payload.detail === 'object'
      ? (item.payload.detail as Record<string, unknown>).attachments
      : null,
    item.payload?.result && typeof item.payload.result === 'object'
      ? (item.payload.result as Record<string, unknown>).attachments
      : null,
    item.payload?.job && typeof item.payload.job === 'object'
      ? ((item.payload.job as Record<string, unknown>).payload as Record<string, unknown> | undefined)?.attachments
      : null,
    item.payload?.files,
  ];
  const rawAttachments = sources.find(Array.isArray);
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const filename = textValue(record.filename);
    if (!filename) return [];
    return [{
      filename,
      content_type: textValue(record.content_type) || 'application/octet-stream',
      size_bytes: typeof record.size_bytes === 'number' && Number.isFinite(record.size_bytes)
        ? record.size_bytes
        : null,
      path:
        textValue(record.path)
        || textValue(record.file_path)
        || textValue(record.local_path)
        || null,
      url:
        textValue(record.url)
        || textValue(record.uri)
        || null,
    }];
  });
}
