import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "spec-bridge — CX サポートデスク",
  description: "機能仕様ドキュメントを根拠に、問い合わせが仕様かバグかを判断します",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
