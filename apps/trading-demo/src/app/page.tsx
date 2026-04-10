import Link from 'next/link';

const REQUIRED_SCORE = Number(process.env.NEXT_PUBLIC_REQUIRED_SCORE ?? 7);

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-slate-800/60 bg-slate-950/80 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <span className="text-emerald-400 font-black text-xl tracking-tight">FHE</span>
          <span className="text-slate-100 font-black text-xl tracking-tight">TradeSafe</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="btn-secondary text-sm py-2 px-4">
            Sign In
          </Link>
          <Link href="/register" className="btn-primary text-sm py-2 px-4">
            Get Started
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-20 text-center">
        <div className="max-w-3xl mx-auto space-y-8 animate-fade-in">

          {/* Trust score requirement banner */}
          <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-emerald-500/30 bg-emerald-950/40 text-emerald-300 text-sm font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            Platform requires a minimum trust score of
            <span className="font-black text-emerald-200 text-base">{REQUIRED_SCORE}/10</span>
            to access trading
          </div>

          <h1 className="text-5xl font-black tracking-tight text-slate-100 leading-tight">
            Trade with confidence.<br />
            <span className="text-emerald-400">Your privacy is encrypted.</span>
          </h1>

          <p className="text-lg text-slate-400 leading-relaxed max-w-2xl mx-auto">
            FHE TradeSafe uses Fully Homomorphic Encryption to evaluate your on-chain trust score
            without ever exposing your wallet data. The platform computes risk analysis on
            encrypted data — the plaintext never leaves your machine.
          </p>

          {/* Score explanation */}
          <div className="grid grid-cols-3 gap-4 max-w-2xl mx-auto mt-4">
            <ScoreCard
              score={`${REQUIRED_SCORE}+`}
              label="Required score"
              desc="Minimum trust score to access the trading dashboard"
              color="emerald"
            />
            <ScoreCard
              score="0–10"
              label="Score range"
              desc="Computed from on-chain behaviour patterns using FHE ML"
              color="violet"
            />
            <ScoreCard
              score="FHE"
              label="Always private"
              desc="Score is computed on encrypted data — no plaintext exposure"
              color="blue"
            />
          </div>

          <div className="flex items-center justify-center gap-4 pt-2">
            <Link href="/register" className="btn-primary text-base px-8 py-3">
              Start Trading
            </Link>
            <Link href="/login" className="btn-secondary text-base px-8 py-3">
              Sign In
            </Link>
          </div>
        </div>
      </main>

      {/* How it works */}
      <section className="border-t border-slate-800/60 bg-slate-900/30 px-6 py-16">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-black text-center text-slate-100 mb-10">How Access Control Works</h2>
          <div className="grid grid-cols-4 gap-6">
            {[
              { step: '01', title: 'Connect Wallet', desc: 'Enter your Ethereum wallet address during sign-in' },
              { step: '02', title: 'FHE Scan', desc: 'Your on-chain activity is analysed under FHE — no plaintext leaves your browser' },
              { step: '03', title: 'Trust Score', desc: `Your score (0–10) is compared against the platform threshold of ${REQUIRED_SCORE}` },
              { step: '04', title: 'Access Granted', desc: `Score ≥ ${REQUIRED_SCORE}: full dashboard access. Score < ${REQUIRED_SCORE}: access denied` },
            ].map(({ step, title, desc }) => (
              <div key={step} className="card text-center space-y-3">
                <span className="text-emerald-400 font-black text-2xl font-mono">{step}</span>
                <h3 className="font-bold text-slate-100">{title}</h3>
                <p className="text-sm text-slate-500 leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-800/60 px-8 py-5 flex items-center justify-between text-xs text-slate-600">
        <span>FHE TradeSafe — Powered by <span className="text-slate-500">@fhe-guard/plugin</span></span>
        <span>Built with Zama FHE</span>
      </footer>
    </div>
  );
}

function ScoreCard({
  score,
  label,
  desc,
  color,
}: {
  score: string;
  label: string;
  desc: string;
  color: 'emerald' | 'violet' | 'blue';
}) {
  const colors = {
    emerald: 'text-emerald-400 border-emerald-500/20 bg-emerald-950/20',
    violet:  'text-violet-400 border-violet-500/20 bg-violet-950/20',
    blue:    'text-blue-400 border-blue-500/20 bg-blue-950/20',
  };
  return (
    <div className={`rounded-xl border p-4 text-center space-y-2 ${colors[color]}`}>
      <div className="text-3xl font-black">{score}</div>
      <div className="font-semibold text-slate-300 text-sm">{label}</div>
      <div className="text-xs text-slate-500 leading-relaxed">{desc}</div>
    </div>
  );
}
