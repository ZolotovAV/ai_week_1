import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nemotron Service",
  description: "Proxy service for OpenRouter Nemotron with JSON and SSE endpoints."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
