import React, { useState } from "react";

export default function App() {
  const [cards, setCards] = useState([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [population, setPopulation] = useState("");

  const addCard = () => {
    if (!name || !price || !population) return;
    setCards([...cards, { name, price, population }]);
    setName("");
    setPrice("");
    setPopulation("");
  };

  const totalMarketCap = cards.reduce(
    (sum, card) => sum + card.price * card.population,
    0
  );

  return (
    <div style={{ fontFamily: "Arial, sans-serif", padding: "20px" }}>
      <h1>PokéSweep</h1>

      <div style={{ marginBottom: "20px" }}>
        <input
          placeholder="Card Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          placeholder="Price"
          type="number"
          value={price}
          onChange={(e) => setPrice(Number(e.target.value))}
        />
        <input
          placeholder="Population"
          type="number"
          value={population}
          onChange={(e) => setPopulation(Number(e.target.value))}
        />
        <button onClick={addCard}>Add Card</button>
      </div>

      <h2>Total Market Cap: {totalMarketCap}</h2>

      <ul>
        {cards.map((card, index) => (
          <li key={index}>
            {card.name} — Price: {card.price}, Population: {card.population}
          </li>
        ))}
      </ul>
    </div>
  );
}
