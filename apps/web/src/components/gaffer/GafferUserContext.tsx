"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  gafferMe,
  gafferLogout,
  GafferApiError,
  type GafferUser,
} from "../../lib/gafferApi";

// ── Context types ──────────────────────────────────────────────────────────

interface GafferUserContextValue {
  user: GafferUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const GafferUserContext = createContext<GafferUserContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────────

export function GafferUserProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, setUser] = useState<GafferUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await gafferMe();
      setUser(res.user);
    } catch (e) {
      if (e instanceof GafferApiError && e.status === 401) {
        setUser(null);
        if (pathname !== "/gaffer/login") {
          router.push("/gaffer/login");
        }
      } else {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, [router, pathname]);

  const logout = useCallback(async () => {
    try {
      await gafferLogout();
    } catch {
      // ignore errors on logout
    }
    setUser(null);
    router.push("/gaffer/login");
  }, [router]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <GafferUserContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </GafferUserContext.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useGafferUser(): GafferUserContextValue {
  const ctx = useContext(GafferUserContext);
  if (!ctx) {
    throw new Error("useGafferUser must be used within GafferUserProvider");
  }
  return ctx;
}
