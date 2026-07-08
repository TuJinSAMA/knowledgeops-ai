import { redirect } from "next/navigation";

import { getServerSession } from "@/lib/session";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Authenticated users have no reason to see the auth screens.
  const session = await getServerSession();
  if (session?.user) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-16">
      {children}
    </main>
  );
}
