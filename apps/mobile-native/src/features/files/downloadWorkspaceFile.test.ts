import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { downloadWorkspaceFile } from './downloadWorkspaceFile';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  downloadAsync: jest.fn(async () => ({ uri: 'file:///cache/result.pdf', status: 200, headers: {} })),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

it('streams a ready workspace transfer to a temporary file and opens the system share sheet', async () => {
  const api = {
    createWorkspaceFileTransfer: jest.fn(async () => ({
      transfer: { transfer_id: 'xfr-1', status: 'queued' },
      job: { job_id: 'job-1' },
    })),
    getWorkspaceFileTransfer: jest.fn(async () => ({
      transfer: {
        transfer_id: 'xfr-1',
        status: 'ready',
        filename: 'result.pdf',
        content_type: 'application/pdf',
        size_bytes: 4096,
      },
    })),
    createWorkspaceFileDownloadTicket: jest.fn(async () => ({
      download_url: 'https://agenthub.example.com/api/download?signed=1',
      expires_at: 1,
    })),
  };

  const result = await downloadWorkspaceFile({
    api: api as never,
    csrfToken: 'csrf',
    workerId: 'worker-1',
    workspaceRoot: 'E:/Work',
    path: 'reports/result.pdf',
  });

  expect(api.createWorkspaceFileTransfer).toHaveBeenCalledWith(
    { worker_id: 'worker-1', workspace_root: 'E:/Work', path: 'reports/result.pdf' },
    'csrf',
  );
  expect(FileSystem.downloadAsync).toHaveBeenCalledWith(
    'https://agenthub.example.com/api/download?signed=1',
    expect.stringMatching(/^file:\/\/\/cache\/agenthub-/),
  );
  expect(Sharing.shareAsync).toHaveBeenCalledWith(
    'file:///cache/result.pdf',
    expect.objectContaining({ mimeType: 'application/pdf' }),
  );
  expect(result.filename).toBe('result.pdf');
});
