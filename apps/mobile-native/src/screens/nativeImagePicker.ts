import * as ImagePicker from 'expo-image-picker';
import type { NativeSessionAttachmentInput } from '../api/mobileApi';

export interface NativePendingImage extends NativeSessionAttachmentInput {
  preview_uri: string;
  size_bytes: number;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function extensionFor(contentType: string): string {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/heic') return 'heic';
  return 'png';
}

export async function pickSessionImage(): Promise<NativePendingImage | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error('需要相册权限才能添加图片');

  const result = await ImagePicker.launchImageLibraryAsync({
    allowsEditing: false,
    base64: true,
    mediaTypes: ['images'],
    quality: 1,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset?.base64) throw new Error('无法读取所选图片');
  const sizeBytes = asset.fileSize ?? Math.ceil(asset.base64.length * 0.75);
  if (sizeBytes > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 8 MB');
  const contentType = asset.mimeType || 'image/png';
  return {
    filename: asset.fileName || `image-${Date.now()}.${extensionFor(contentType)}`,
    content_type: contentType,
    data_base64: asset.base64,
    preview_uri: asset.uri,
    size_bytes: sizeBytes,
  };
}
