import { motion } from 'framer-motion'

export default function GlassCard({
  children,
  className = '',
  as: Component = motion.div,
  ...props
}) {
  return (
    <Component
      className={`glass-panel rounded-2xl shadow-xl shadow-gray-900/5 ${className}`}
      {...props}
    >
      {children}
    </Component>
  )
}
