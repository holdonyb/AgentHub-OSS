declare module 'expo-clipboard' {
  export function setStringAsync(text: string): Promise<boolean>;
}
