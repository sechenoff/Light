import Link from "next/link";

export default function LkLoginSentPage() {
  return (
    <div className="w-full max-w-[420px] text-center space-y-4">
      <h1 className="text-xl font-medium">Проверьте почту</h1>
      <p className="text-ink-2">
        Если этот email есть в нашей системе — мы отправили ссылку для входа. Она действительна 15
        минут.
      </p>
      <Link href="/lk/login" className="text-accent-bright text-sm underline">
        Отправить ещё раз
      </Link>
    </div>
  );
}
