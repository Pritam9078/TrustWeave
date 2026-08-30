import { useRef, useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * A field of soft indigo/gray nodes connected by thin lines, drifting
 * slowly and responding to mouse position with a subtle camera parallax.
 * Deliberately light and airy — this is not a "hacker network" visual,
 * it's meant to read as calm, verified, structured trust.
 */
function NodeField({ count = 90, scroll = 0 }) {
  const group = useRef()
  const { viewport } = useThree()

  // Precompute a stable random field of node positions
  const nodes = useMemo(() => {
    const arr = []
    for (let i = 0; i < count; i++) {
      arr.push({
        position: [
          (Math.random() - 0.5) * 18,
          (Math.random() - 0.5) * 12,
          (Math.random() - 0.5) * 10 - 4,
        ],
        speed: 0.05 + Math.random() * 0.1,
        offset: Math.random() * Math.PI * 2,
      })
    }
    return arr
  }, [count])

  // Build line connections between nearby nodes once
  const lineGeometry = useMemo(() => {
    const positions = []
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = new THREE.Vector3(...nodes[i].position)
        const b = new THREE.Vector3(...nodes[j].position)
        if (a.distanceTo(b) < 3.2) {
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z)
        }
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3)
    )
    return geometry
  }, [nodes])

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (group.current) {
      // Ambient slow rotation
      group.current.rotation.y = t * 0.02 + scroll * 0.3
      group.current.rotation.x = Math.sin(t * 0.05) * 0.05

      // Subtle mouse parallax — camera nudges, not snaps
      const targetX = state.mouse.x * 0.6
      const targetY = state.mouse.y * 0.4
      group.current.rotation.y += targetX * 0.05
      group.current.rotation.x += -targetY * 0.05
    }
  })

  return (
    <group ref={group}>
      <lineSegments geometry={lineGeometry}>
        <lineBasicMaterial color="#FECACA" transparent opacity={0.35} />
      </lineSegments>
      {nodes.map((n, i) => (
        <mesh key={i} position={n.position}>
          <sphereGeometry args={[0.06 + (i % 3) * 0.02, 12, 12]} />
          <meshBasicMaterial
            color={i % 5 === 0 ? '#DC2626' : '#9CA3AF'}
            transparent
            opacity={i % 5 === 0 ? 0.9 : 0.5}
          />
        </mesh>
      ))}
    </group>
  )
}

export default function NetworkCanvas({ scroll = 0, className = '' }) {
  return (
    <div className={`pointer-events-none fixed inset-0 -z-10 ${className}`}>
      <Canvas
        camera={{ position: [0, 0, 9], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
        dpr={[1, 1.5]}
      >
        <color attach="background" args={['#F9FAFB']} />
        <ambientLight intensity={0.8} />
        <NodeField scroll={scroll} />
      </Canvas>
    </div>
  )
}
