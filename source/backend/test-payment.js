async function run() {
  const login = await fetch("http://localhost:4001/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@northwind.test", password: "TrustWeave!2026" })
  });
  const { token } = await login.json();

  const res = await fetch("http://localhost:4001/api/agents/task", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      instruction: "Pay 500 INR to AWS",
      execute: true
    })
  });
  console.log(res.status, JSON.stringify(await res.json(), null, 2));
}
run();
