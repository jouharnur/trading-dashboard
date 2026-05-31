import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "RD11 Dashboard",
  description: "Live FTMO + Pepperstone telemetry",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
