import type { NextPageContext } from "next";

type ErrorPageProps = {
  statusCode?: number;
};

function ErrorPage({ statusCode }: ErrorPageProps) {
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
        <p style={{ letterSpacing: "0.12em", textTransform: "uppercase" }}>
          {statusCode ?? 500}
        </p>
        <h1>Something went wrong</h1>
      </div>
    </main>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext) => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 500;
  return { statusCode };
};

export default ErrorPage;
