import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "remit-corridor-fx · WasiAI A2A agent",
  description: "USDC→PEN remittance corridor FX quote agent (A2A protocol).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
