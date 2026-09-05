import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

// No StrictMode. It double-invokes effects in development, which would build two
// Game instances, two WebGL contexts and two audio graphs on top of each other.
// The game owns imperative resources; it wants to mount exactly once.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
