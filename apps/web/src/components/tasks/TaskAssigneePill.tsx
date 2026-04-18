"use client";

// ── Детерминированные цвета аватарок ─────────────────────────────────────────
// 5 canonical semantic-token класса, hash по userId.id char-codes
const AVATAR_COLORS = [
  "bg-teal",
  "bg-amber",
  "bg-indigo",
  "bg-rose",
  "bg-emerald",
];

function avatarColorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) & 0xffff;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// ── TaskAssigneePill ──────────────────────────────────────────────────────────

interface TaskAssigneePillProps {
  user: { id: string; username: string } | null | undefined;
}

export function TaskAssigneePill({ user }: TaskAssigneePillProps) {
  if (!user) {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface-deep text-xs font-medium text-ink-3">
        <span className="w-5 h-5 rounded-full bg-slate text-white text-[10px] font-semibold flex items-center justify-center">
          ?
        </span>
        никому
      </span>
    );
  }

  const colorClass = avatarColorFor(user.id);

  return (
    <span
      title={user.username}
      className="inline-flex items-center gap-2 pr-3 pl-1 py-1 rounded-full bg-surface-deep text-xs font-medium text-ink-2"
    >
      <span
        className={`w-5 h-5 rounded-full text-white text-[10px] font-semibold flex items-center justify-center ${colorClass}`}
      >
        {user.username.charAt(0).toUpperCase()}
      </span>
      {user.username}
    </span>
  );
}
