import { createAuthClient } from "better-auth/react";

// NEXT_PUBLIC_APP_URL is inlined at build time and safe to read in the browser.
// Falls back to localhost for local development.
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
});

export const { signIn, signUp, signOut, useSession } = authClient;
