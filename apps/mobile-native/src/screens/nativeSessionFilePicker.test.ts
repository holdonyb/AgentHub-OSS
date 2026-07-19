import { createSessionFilePicker } from './nativeSessionFilePicker';

function createPicker(overrides: {
  asset?: {
    mimeType: string | null;
    name: string;
    size: number | null;
    uri: string;
  } | null;
  canceled?: boolean;
  fileSize?: number | null;
  fileBase64?: string;
} = {}) {
  const pickDocument = jest.fn(async () => ({
    canceled: overrides.canceled ?? false,
    assets: overrides.asset === undefined ? [{
      name: '需求说明.md',
      mimeType: 'text/markdown',
      size: 6,
      uri: 'file:///requirements.md',
    }] : overrides.asset ? [overrides.asset] : [],
  }));
  const createFile = jest.fn(() => ({
    size: overrides.fileSize ?? 6,
    base64: jest.fn(async () => overrides.fileBase64 ?? 'c2FtcGxl'),
  }));
  return { createFile, pickDocument, pickSessionFile: createSessionFilePicker({ createFile, pickDocument }) };
}

it('reads a bounded document selected from the system picker', async () => {
  const { pickDocument, pickSessionFile } = createPicker();

  await expect(pickSessionFile()).resolves.toEqual({
    filename: '需求说明.md',
    content_type: 'text/markdown',
    data_base64: 'c2FtcGxl',
    preview_uri: 'file:///requirements.md',
    size_bytes: 6,
  });
  expect(pickDocument).toHaveBeenCalledWith({ copyToCacheDirectory: true, multiple: false });
});

it('rejects a document larger than eight megabytes before reading its body', async () => {
  const { createFile, pickSessionFile } = createPicker({
    asset: {
      name: 'archive.zip',
      mimeType: 'application/zip',
      size: 8 * 1024 * 1024 + 1,
      uri: 'file:///archive.zip',
    },
  });

  await expect(pickSessionFile()).rejects.toThrow('附件不能超过 8 MB');
  expect(createFile).not.toHaveBeenCalled();
});

it('returns null when the document picker is cancelled', async () => {
  const { pickSessionFile } = createPicker({ canceled: true });
  await expect(pickSessionFile()).resolves.toBeNull();
});
