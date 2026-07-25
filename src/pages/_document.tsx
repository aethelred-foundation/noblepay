import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en" className="dark">
      <Head>
        <meta charSet="utf-8" />
        <meta name="theme-color" content="#0f172a" />
        <meta name="color-scheme" content="dark" />
        <link rel="icon" href="/noblepay-mark.svg" type="image/svg+xml" />
        <link rel="manifest" href="/manifest.json" />
        <meta
          name="description"
          content="NoblePay — Enterprise cross-border payments with TEE-based compliance on the Aethelred network"
        />
      </Head>
      <body className="bg-[#0f172a] text-slate-200 antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
