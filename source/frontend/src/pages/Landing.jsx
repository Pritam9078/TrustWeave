import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import NetworkCanvas from '../components/NetworkCanvas'
import GlassCard from '../components/GlassCard'

const STORY_SECTIONS = [
  {
    eyebrow: 'Identity & Roles',
    title: 'Every AI agent carries a verifiable identity.',
    body: 'Each autonomous agent operating in your organization is issued a decentralized identity, cryptographically bound to its owner and specific role. No shared API keys, no ambiguity.',
  },
  {
    eyebrow: 'Zero Trust Authorization',
    title: 'AI proposes, the engine decides.',
    body: 'Language models have no intrinsic authority. Our 11-Gate Authorization Engine intercepts every AI proposal (read, write, execute) and re-authorizes it from scratch against your strict security policies.',
  },
  {
    eyebrow: 'Human-in-the-Loop',
    title: 'Seamless escalation for high-stakes actions.',
    body: 'When an AI attempts a sensitive action like a financial payment or infrastructure change, the system automatically suspends the request and routes it to an authorized human operator for one-click approval.',
  },
  {
    eyebrow: 'Immutable Proofs',
    title: 'Tamper-evident audit trails.',
    body: 'Organization-wide decisions are securely anchored on EVM smart contracts. You can prove definitively to auditors and customers exactly which agent performed an action and why it was allowed.',
  },
  {
    eyebrow: 'Control Plane',
    title: 'Govern your entire AI workforce from one dashboard.',
    body: 'Manage agent identities, configure granular scopes, define emergency kill-switches, and monitor all activity in real time through the centralized TrustWeave console.',
  },
]

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: 'easeOut' } },
}

export default function Landing() {
  const navigate = useNavigate()
  const [scroll, setScroll] = useState(0)

  useEffect(() => {
    const onScroll = () => {
      const max = document.body.scrollHeight - window.innerHeight
      setScroll(max > 0 ? window.scrollY / max : 0)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="relative min-h-[300vh] bg-slate-50 selection:bg-slate-200">
      <NetworkCanvas scroll={scroll} />

      {/* Hero */}
      <section className="relative flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <GlassCard
          className="max-w-2xl px-8 py-10 sm:px-12 sm:py-14"
          initial="hidden"
          animate="visible"
          variants={fadeUp}
        >
          <p className="mb-3 text-sm font-medium uppercase tracking-widest text-red-600">
            TrustWeave
          </p>
          <h1 className="text-3xl font-bold leading-tight text-slate-900 sm:text-5xl">
            Trust, verified at every action.
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-base text-slate-600 sm:text-lg">
            A blockchain-based authorization layer for the autonomous agents
            operating inside your organization.
          </p>
          <button
            onClick={() => navigate('/login')}
            className="focus-ring mt-8 inline-flex items-center gap-2 rounded-xl bg-red-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-red-600/20 transition-colors hover:bg-red-700"
          >
            Go to Authorization Gateway
            <span aria-hidden="true">→</span>
          </button>
        </GlassCard>

        <motion.div
          className="absolute bottom-8 text-xs font-medium uppercase tracking-widest text-slate-500"
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 2.4, repeat: Infinity }}
        >
          Scroll to see how it works
        </motion.div>
      </section>

      {/* Scroll storytelling sections */}
      {STORY_SECTIONS.map((section, i) => (
        <section
          key={section.eyebrow}
          className="relative flex min-h-screen items-center justify-center px-6"
        >
          <GlassCard
            className={`max-w-lg px-8 py-10 sm:px-10 ${
              i % 2 === 0 ? 'sm:mr-auto sm:ml-12' : 'sm:ml-auto sm:mr-12'
            }`}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.5 }}
            variants={fadeUp}
          >
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-red-600">
              {section.eyebrow}
            </p>
            <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
              {section.title}
            </h2>
            <p className="mt-3 text-slate-600">{section.body}</p>
          </GlassCard>
        </section>
      ))}

      {/* Closing CTA */}
      <section className="relative flex min-h-[60vh] items-center justify-center px-6">
        <GlassCard
          className="px-8 py-10 text-center sm:px-12"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.6 }}
          variants={fadeUp}
        >
          <h2 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            See it enforced in real time.
          </h2>
          <button
            onClick={() => navigate('/login')}
            className="focus-ring mt-6 inline-flex items-center gap-2 rounded-xl bg-red-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-red-600/20 transition-colors hover:bg-red-700"
          >
            Go to Authorization Gateway
            <span aria-hidden="true">→</span>
          </button>
        </GlassCard>
      </section>
    </div>
  )
}
