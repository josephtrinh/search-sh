import type { Metadata } from "next";
import Link from "next/link";
import "./styles.css";

export const metadata: Metadata = { title: "SampleHub Search Lab", description: "Multimodal material discovery" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <header className="topbar"><Link className="brand" href="/"><span className="brand-mark">S</span><span>SampleHub <em>Search Lab</em></span></Link>
      <nav><Link href="/">Discover</Link><Link href="/admin">Evaluator</Link></nav></header>
    {children}<footer>Local evaluation workspace · SigLIP 2 + Meilisearch</footer>
  </body></html>;
}
