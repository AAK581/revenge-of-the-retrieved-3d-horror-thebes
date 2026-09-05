import GameCanvas from "./game/GameCanvas";

// The Thebes scaffold's counter demo used to live here. The chain-facing helpers
// in ./thebes.ts are still present and still work; the game is what ships from
// the asset canister now.
export default function App() {
  return <GameCanvas />;
}
