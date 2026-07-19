import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { MobileApi, NativeWorkspaceFileTransfer } from '../../api/mobileApi';

type DownloadApi = Pick<
  MobileApi,
  'createWorkspaceFileTransfer' | 'getWorkspaceFileTransfer' | 'createWorkspaceFileDownloadTicket'
>;

export async function downloadWorkspaceFile({
  api,
  csrfToken,
  workerId,
  workspaceRoot,
  path,
}: {
  api: DownloadApi;
  csrfToken: string;
  workerId: string;
  workspaceRoot: string;
  path: string;
}): Promise<{ uri: string; filename: string; contentType: string }> {
  const created = await api.createWorkspaceFileTransfer(
    { worker_id: workerId, workspace_root: workspaceRoot, path },
    csrfToken,
  );
  const transfer = await waitForReadyTransfer(api, created.transfer.transfer_id);
  const ticket = await api.createWorkspaceFileDownloadTicket(transfer.transfer_id, csrfToken);
  const filename = safeFilename(transfer.filename || path.split(/[\\/]/).pop() || 'agenthub-file');
  const destination = `${FileSystem.cacheDirectory ?? ''}agenthub-${Date.now()}-${filename}`;
  const downloaded = await FileSystem.downloadAsync(ticket.download_url, destination);
  if (downloaded.status < 200 || downloaded.status >= 300) {
    throw new Error(`下载失败（HTTP ${downloaded.status}）`);
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(downloaded.uri, {
      dialogTitle: `保存或打开 ${filename}`,
      mimeType: transfer.content_type || 'application/octet-stream',
    });
  }
  return {
    uri: downloaded.uri,
    filename,
    contentType: transfer.content_type || 'application/octet-stream',
  };
}

async function waitForReadyTransfer(api: DownloadApi, transferId: string): Promise<NativeWorkspaceFileTransfer> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { transfer } = await api.getWorkspaceFileTransfer(transferId);
    if (transfer.status === 'ready') return transfer;
    if (transfer.status === 'failed' || transfer.status === 'expired') {
      throw new Error(transfer.status === 'expired' ? '文件传输已过期' : 'Worker 准备文件失败');
    }
    if (attempt < 39) await delay(350);
  }
  throw new Error('Worker 准备文件超时，请稍后重试');
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'agenthub-file';
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
