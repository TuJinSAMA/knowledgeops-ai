import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hameo KnowledgeOps AI",
  description:
    "Enterprise AI knowledge quality platform for building, evaluating, and operating trustworthy RAG-powered knowledge assistants.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
