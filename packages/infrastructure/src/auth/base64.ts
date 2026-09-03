const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeBase64(value: string): string {
  const bytes = textEncoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(wrapped: string): string {
  const binary = atob(wrapped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return textDecoder.decode(bytes);
}
