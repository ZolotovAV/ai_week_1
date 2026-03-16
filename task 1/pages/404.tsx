export default function Custom404() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
        background: "#f4f1e8",
        color: "#26190e",
        fontFamily: "Georgia, serif"
      }}
    >
      <div style={{ textAlign: "center" }}>
        <p style={{ letterSpacing: "0.12em", textTransform: "uppercase" }}>404</p>
        <h1>Page not found</h1>
      </div>
    </main>
  );
}
