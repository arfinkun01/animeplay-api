import app from "./app";
import { autoStartRetry } from "./routes/admin";

const port = Number(process.env.PORT || 3000);

// Only start HTTP server when running directly (not in Vercel serverless)
if (process.env.VERCEL !== "1") {
  app.listen(port, (err?: Error) => {
    if (err) {
      console.error("Error listening on port", err);
      process.exit(1);
    }
    console.log(`Server listening on port ${port}`);

    // Auto-resume stream retry sync 5s after boot
    setTimeout(autoStartRetry, 5000);
  });
}

export default app;
