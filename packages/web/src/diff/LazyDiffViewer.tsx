// Pembungkus pemuat belakangan untuk penampil diff. Selama kode penampil belum siap (jaringan lambat, atau offline
// dan belum tersimpan), layar menampilkan `fallback` (diff sebagai teks biasa) sehingga isinya tetap terbaca. Bila
// pemuatan gagal, `fallback` tetap tampil: kegagalan memuat tampilan tidak boleh merusak layar keputusan.
import type { FileDiff } from "@agentmon/shared";
import { Component, lazy, Suspense, type ReactNode } from "react";

const DiffViewer = lazy(() => import("./DiffViewer"));

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function LazyDiffViewer({ diffs, fallback }: { diffs: FileDiff[]; fallback: ReactNode }) {
  return (
    <Boundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <DiffViewer diffs={diffs} />
      </Suspense>
    </Boundary>
  );
}
