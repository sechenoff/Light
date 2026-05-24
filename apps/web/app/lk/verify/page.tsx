"use client";
import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { lkApi } from "../../../src/lib/lkApi";

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      router.replace("/lk/login");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await lkApi.verify(token);
        if (!cancelled) router.replace("/lk");
      } catch {
        if (!cancelled) setError("Ссылка недействительна или истекла");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, router]);

  return (
    <div className="text-center">
      {error ? (
        <>
          <p className="text-rose mb-3">{error}</p>
          <a href="/lk/login" className="text-accent-bright underline">
            Запросить новую ссылку
          </a>
        </>
      ) : (
        <p className="text-ink-2">Проверяем ссылку…</p>
      )}
    </div>
  );
}

export default function LkVerifyPage() {
  return (
    <Suspense fallback={<p className="text-ink-2">Проверяем ссылку…</p>}>
      <VerifyInner />
    </Suspense>
  );
}
