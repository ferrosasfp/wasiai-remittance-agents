export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, lineHeight: 1.5 }}>
      <h1>remit-corridor-fx</h1>
      <p>USDC→PEN remittance corridor FX quote agent — WasiAI A2A protocol.</p>
      <p>
        Invoke: <code>POST /api/agents/remit-corridor-fx/invoke</code>
      </p>
    </main>
  );
}
