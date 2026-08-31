async function run() {
  const login = await fetch("http://localhost:4001/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@northwind.test", password: "TrustWeave!2026" })
  });
  const { token } = await login.json();

  const res = await fetch("http://localhost:4001/api/policies", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      policyKey: "pol_test2",
      name: "Test Policy",
      conditions: { rules: [] }
    })
  });
  console.log(res.status, await res.text());
}
run();
