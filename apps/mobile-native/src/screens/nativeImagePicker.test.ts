import * as ImagePicker from 'expo-image-picker';
import { pickSessionImage } from './nativeImagePicker';

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const requestPermission = jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync);
const launchPicker = jest.mocked(ImagePicker.launchImageLibraryAsync);

beforeEach(() => {
  jest.clearAllMocks();
  requestPermission.mockResolvedValue({ granted: true } as never);
});

it('returns a bounded base64 image selected from the system library', async () => {
  launchPicker.mockResolvedValue({
    canceled: false,
    assets: [{
      uri: 'file:///screen.png',
      fileName: 'screen.png',
      mimeType: 'image/png',
      fileSize: 5,
      base64: 'aW1hZ2U=',
    }],
  } as never);

  await expect(pickSessionImage()).resolves.toEqual({
    filename: 'screen.png',
    content_type: 'image/png',
    data_base64: 'aW1hZ2U=',
    preview_uri: 'file:///screen.png',
    size_bytes: 5,
  });
  expect(launchPicker).toHaveBeenCalledWith(expect.objectContaining({ base64: true }));
});

it('returns null when the picker is cancelled', async () => {
  launchPicker.mockResolvedValue({ canceled: true, assets: null } as never);
  await expect(pickSessionImage()).resolves.toBeNull();
});

it('explains missing photo permission', async () => {
  requestPermission.mockResolvedValue({ granted: false } as never);
  await expect(pickSessionImage()).rejects.toThrow('需要相册权限');
  expect(launchPicker).not.toHaveBeenCalled();
});

it('rejects images larger than eight megabytes', async () => {
  launchPicker.mockResolvedValue({
    canceled: false,
    assets: [{
      uri: 'file:///large.jpg',
      fileName: 'large.jpg',
      mimeType: 'image/jpeg',
      fileSize: 8 * 1024 * 1024 + 1,
      base64: 'aW1hZ2U=',
    }],
  } as never);
  await expect(pickSessionImage()).rejects.toThrow('不能超过 8 MB');
});
