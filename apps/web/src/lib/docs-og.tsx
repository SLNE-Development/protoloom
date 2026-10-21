import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/** Share card size used by Open Graph and X. */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/** Shared visual style of every Protoloom share card. */
const STYLE = {
  background: "#0a0a0a",
  text: "#ededed",
  muted: "#8f8f8f",
  hairline: "#262626",
  accent: "#7aa2ff",
  padding: 64,
  logo: 72,
} as const;

type Font = { name: string; data: Buffer; weight: 400 | 500 | 600; style: "normal" };

let fontsPromise: Promise<Font[]> | undefined;

/**
 * Satori reads WOFF but not WOFF2, so the static Geist builds of @fontsource (which ship .woff) are
 * used here; the app itself uses the variable WOFF2 fonts. The paths are spelled out literally so the
 * bundler traces exactly these files into the standalone output.
 */
function loadFonts(): Promise<Font[]> {
  fontsPromise ??= Promise.all([
    readFile(join(process.cwd(), "node_modules", "@fontsource", "geist", "files", "geist-latin-400-normal.woff")),
    readFile(join(process.cwd(), "node_modules", "@fontsource", "geist", "files", "geist-latin-600-normal.woff")),
    readFile(join(process.cwd(), "node_modules", "@fontsource", "geist-mono", "files", "geist-mono-latin-500-normal.woff")),
  ]).then(([regular, semibold, mono]) => [
    { name: "Geist", data: regular, weight: 400, style: "normal" },
    { name: "Geist", data: semibold, weight: 600, style: "normal" },
    { name: "Geist Mono", data: mono, weight: 500, style: "normal" },
  ]);
  fontsPromise.catch(() => {
    fontsPromise = undefined;
  });
  return fontsPromise;
}

/** The woven logo, inverted for the dark card (white tile, black threads); mirrors protoloom-icon-inverted.svg. */
function Logo() {
  return (
    <svg width={STYLE.logo} height={STYLE.logo} viewBox="0 0 64 64">
      <rect width="64" height="64" rx="16" fill="#ffffff" />
      <path d="M20 13V51M32 13V51M44 13V51M13 20H51M13 32H51M13 44H51" fill="none" stroke="#000000" strokeWidth="6" strokeLinecap="round" />
      <path
        d="M20 14.25V25.75M14.25 32H25.75M20 38.25V49.75M26.25 20H37.75M32 26.25V37.75M26.25 44H37.75M44 14.25V25.75M38.25 32H49.75M44 38.25V49.75"
        fill="none"
        stroke="#ffffff"
        strokeWidth="10.5"
      />
      <path
        d="M20 13.25V26.75M13.25 32H26.75M20 37.25V50.75M25.25 20H38.75M32 25.25V38.75M25.25 44H38.75M44 13.25V26.75M37.25 32H50.75M44 37.25V50.75"
        fill="none"
        stroke="#000000"
        strokeWidth="6"
      />
    </svg>
  );
}

/** Content of a docs share card. */
export interface DocsOgCard {
  /** Short mono line above the title, such as `Docs · Getting started`. */
  eyebrow: string;
  title: string;
  subtitle: string;
  /** Instance host shown bottom left, such as `protos.example.com`. */
  host: string;
  /** Page path shown bottom right, such as `/docs/admin/keys`. */
  path: string;
}

/** Renders a 1200×630 docs share card: logo, mono eyebrow, big title, subtitle, and a footer with the host. */
export async function renderDocsOgCard({ eyebrow, title, subtitle, host, path }: DocsOgCard): Promise<ImageResponse> {
  const fonts = await loadFonts();
  const titleSize = title.length > 34 ? 60 : 72;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: STYLE.background,
          color: STYLE.text,
          padding: STYLE.padding,
          fontFamily: "Geist",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <Logo />
          <div style={{ display: "flex", fontSize: 34, fontWeight: 600, letterSpacing: "-0.02em" }}>Protoloom</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", marginBottom: "auto", paddingTop: 24 }}>
          <div
            style={{
              display: "flex",
              fontFamily: "Geist Mono",
              fontWeight: 500,
              fontSize: 26,
              color: STYLE.accent,
              letterSpacing: "0.02em",
            }}
          >
            {eyebrow}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 18,
              fontSize: titleSize,
              fontWeight: 600,
              lineHeight: 1.08,
              letterSpacing: "-0.035em",
            }}
          >
            {title}
          </div>
          <div style={{ display: "flex", marginTop: 22, fontSize: 30, lineHeight: 1.4, color: STYLE.muted, maxWidth: 1000 }}>
            {subtitle.length > 150 ? `${subtitle.slice(0, 147)}…` : subtitle}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: `1px solid ${STYLE.hairline}`,
            paddingTop: 26,
            fontFamily: "Geist Mono",
            fontWeight: 500,
            fontSize: 24,
            color: STYLE.muted,
          }}
        >
          <div style={{ display: "flex" }}>{host}</div>
          <div style={{ display: "flex" }}>{path}</div>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts },
  );
}
