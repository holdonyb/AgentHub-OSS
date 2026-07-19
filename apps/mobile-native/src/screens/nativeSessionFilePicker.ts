import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import type { NativeSessionAttachmentInput } from '../api/mobileApi';

export interface NativePendingFile extends NativeSessionAttachmentInput {
  preview_uri: string;
  size_bytes: number;
}

interface NativeDocumentAsset {
  mimeType?: string | null;
  name?: string | null;
  size?: number | null;
  uri: string;
}

interface NativeDocumentResult {
  assets?: NativeDocumentAsset[] | null;
  canceled: boolean;
}

interface NativeReadableFile {
  base64(): Promise<string>;
  size?: number | null;
}

export interface SessionFilePickerDependencies {
  createFile(uri: string): NativeReadableFile;
  pickDocument(options: { copyToCacheDirectory: boolean; multiple: boolean }): Promise<NativeDocumentResult>;
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function contentTypeFor(name: string, declared: string | null | undefined) {
  const normalized = declared?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized && normalized !== 'application/octet-stream') return normalized;
  const extension = name.split('.').pop()?.trim().toLowerCase();
  const fallbackByExtension: Record<string, string> = {
    csv: 'text/csv',
    json: 'application/json',
    md: 'text/markdown',
    pdf: 'application/pdf',
    txt: 'text/plain',
    xml: 'application/xml',
    zip: 'application/zip',
  };
  return (extension && fallbackByExtension[extension]) || normalized || 'application/octet-stream';
}

const defaultDependencies: SessionFilePickerDependencies = {
  createFile: (uri) => new File(uri) as unknown as NativeReadableFile,
  pickDocument: (options) => DocumentPicker.getDocumentAsync(options) as unknown as Promise<NativeDocumentResult>,
};

export function createSessionFilePicker(dependencies: SessionFilePickerDependencies = defaultDependencies) {
  return async function pickSessionFile(): Promise<NativePendingFile | null> {
    const result = await dependencies.pickDocument({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return null;
    const asset = result.assets?.[0];
    if (!asset) return null;
    const filename = asset.name?.trim() || `attachment-${Date.now()}`;
    if ((asset.size ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error('附件不能超过 8 MB');
    const file = dependencies.createFile(asset.uri);
    const sizeBytes = asset.size ?? file.size ?? 0;
    if (sizeBytes > MAX_ATTACHMENT_BYTES) throw new Error('附件不能超过 8 MB');
    const dataBase64 = await file.base64();
    if (!dataBase64) throw new Error('无法读取所选附件');
    return {
      filename,
      content_type: contentTypeFor(filename, asset.mimeType),
      data_base64: dataBase64,
      preview_uri: asset.uri,
      size_bytes: sizeBytes,
    };
  };
}

export const pickSessionFile = createSessionFilePicker();
