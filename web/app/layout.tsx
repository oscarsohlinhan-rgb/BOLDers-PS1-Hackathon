import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Project TAO",
  description: "Deterministic railway track-access planning with reviewed AI-assisted data intake.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
