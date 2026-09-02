<div align="center">

<img src="source/frontend/public/logo.svg" width="120" alt="TrustWeave Logo"/>

# ⬡ TRUSTWEAVE

### *Sovereign Infrastructure for Trustless Cross-Chain Automation*

> Cryptographic certainty. Zero trust. Infinite interoperability.

[![Live Demo](https://img.shields.io/badge/🌐_Live_Demo-Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://trustweave.vercel.app/)
[![Backend API](https://img.shields.io/badge/⚡_Backend_API-Render-46E3B7?style=for-the-badge&logo=render&logoColor=white)](https://trustweave-backend.onrender.com/)
[![Demo Video](https://img.shields.io/badge/🎬_Full_Walkthrough-Google_Drive-4285F4?style=for-the-badge&logo=googledrive&logoColor=white)](https://drive.google.com/file/d/1vFOfGjbB2ehYbs4v8T5p3AgA8TBAU9KX/view?usp=drive_link)
[![GitHub](https://img.shields.io/badge/📦_Source_Code-GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Pritam9078/TrustWeave)

</div>

---

## 🚀 Live Links

- **🌐 Live Demo (Frontend):** [https://trustweave.vercel.app/](https://trustweave.vercel.app/)
- **⚡ Backend API Server:** [https://trustweave-backend.onrender.com](https://trustweave-backend.onrender.com/)
- **📐 System Architecture:** [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md)

---

## ✦ The Problem
In modern enterprise environments, integrating Autonomous AI Agents into critical workflows (like finance, procurement, and operations) introduces significant security and accountability risks:
1. **Unpredictable AI Logic:** Large Language Models (LLMs) can hallucinate or be manipulated via prompt injection, leading to unauthorized actions.
2. **Lack of Immutable Auditability:** Traditional databases can be retroactively altered by malicious administrators, obscuring the true origin of an AI-driven decision.
3. **Implicit Trust:** Most systems trust the AI's output implicitly without a dedicated, deterministic authorization layer to double-check the AI's intent against hardcoded business rules.

## ✦ Our Solution
**TrustWeave** solves these issues by shifting the paradigm from "AI executes" to **"AI proposes, the authorization engine decides."** 
We provide a sovereign infrastructure layer that anchors AI operations to a cryptographically verifiable ledger. By combining deterministic Role-Based Access Control (RBAC), secure Retrieval-Augmented Generation (RAG), and an immutable EVM-based blockchain registry, TrustWeave guarantees that no action occurs without rigorous, verifiable authorization.

## ✦ How It Works
1. **Secure Intent Extraction:** When a user interacts with the system, the AI Agent extracts a structured "intent" (e.g., *transfer funds*).
2. **The 11-Gate Authorization Engine:** Before execution, this intent is stripped of all autonomy and evaluated by a strict 11-step deterministic gateway. It checks capabilities, tenant boundaries, risk scores, hard limits, and human-in-the-loop (HITL) policies.
3. **Execution & Immutable Auditing:** If approved, the action is executed. Simultaneously, the system generates a sequential cryptographic hash of the event, chaining it to the previous event state.
4. **Blockchain Anchoring:** These audit trails are periodically anchored to our smart contracts deployed on an EVM-compatible network, creating a mathematically undeniable proof of the AI's action and the authorization decision.

---

## ✦ Secure RAG Pipeline & Smart Contracts

**TrustWeave** ensures that every actor — human or AI — holds a cryptographically verifiable identity. The central commitment is: **AI proposes, the authorization engine decides.**

### 🧠 Secure Retrieval-Augmented Generation (RAG)
TrustWeave implements a highly secure RAG pipeline that enforces access control **before** generation. The RAG engine filters out-of-scope context based on the authenticated actor's tenant boundaries before it ever reaches the LLM.

### 🔗 Smart Contract Addresses (Localhost EVM)
The following core registries manage on-chain truth and cryptographic audit anchoring on the local Hardhat node.

| Registry Contract | Deployed Address |
|---|---|
| **Identity Registry** | `0x5fbdb2315678afecb367f032d93f642f64180aa3` |
| **Asset Registry** | `0xe7f1725e7734ce288f8367e1bb143e90bb3f0512` |
| **Agent Registry** | `0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0` |
| **Proof Registry** | `0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9` |

> *To deploy to a live network like Sepolia, update the `CHAIN_RPC_URL` and run `npm run deploy:sepolia`.*

---

## ✦ Demo Accounts & Testing

Printed by `npm run db:seed`. Password sign-in is a development convenience; DID challenge/response is the supported path.

| Role | Email | Scope & Permissions |
|---|---|---|
| **Admin** | `admin@northwind.test` | Full control plane access |
| **Manager** | `manager@northwind.test` | Finance only, ₹5,00,000 scope cap |
| **Auditor** | `auditor@northwind.test` | Read-only — zero mutating capabilities |
| **User** | `user@northwind.test` | Operations department, own records only |

*Default password:* `TrustWeave!2026`

**FinanceAgent-01** is also seeded. Its limits: approval required above ₹50,000, hard ceiling ₹2,00,000, ₹5,00,000 per day, 10 calls per day.

---

## ✦ Local Development & Quickstart

### Prerequisites
- **Node.js**: ≥ 22.5 (tested on 22.22)
- A modern browser for Web Crypto Ed25519 DID sign-in (Chrome 137+, Firefox 129+, Safari 17+)

### Quickstart

The system runs **fully end to end with an empty `.env`**. An in-memory chain, SQLite storage, deterministic payment provider, and rule-based LLM extractor are used by default.

```bash
# 1. Backend
cd source/backend
cp .env.example .env          
npm install
npm run db:migrate
npm run db:seed               # Prints demo credentials
npm run dev                   # Starts on http://localhost:4000

# 2. Frontend (in a second terminal)
cd source/frontend
cp .env.example .env
npm install
npm run dev                   # Starts on http://localhost:5173

# 3. Smart Contracts (in a third terminal)
cd source/contracts
npx hardhat node              # Starts Local EVM

# 4. Deploy Contracts (in a fourth terminal)
cd source/contracts
npm run deploy:local          # Deploys Registries
npm run wire-backend          # Pipes addresses to backend/.env
```
