import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Connect an account | Notte",
  description: "Sign in through a live Notte browser and save your login as a reusable browser profile.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
