import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Heater Ver1 — Admin Dashboard",
    template: "%s · Heater Ver1",
  },
  description:
    "Real-time monitoring and control for the Heater Ver1 ESP32 fleet: connectivity, signal strength, temperature and fault history.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The dashboard is a light, white UI in every OS colour scheme.
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
