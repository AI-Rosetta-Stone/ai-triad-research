// t/4787 chat share configuration (K5: externalized config values)

export const CHAT_SHARE_CONFIG = {
  MAX_ACTIVE: 20,           // max chats per user with active shares (K5)
  CREATES_PER_HOUR: 5,      // create rate limit per user (K5)
  TTL_DAYS: 30,             // share expiration time-to-live (K5)
  PUBLIC_READ_PER_HOUR: 100, // read rate limit per IP
} as const;
