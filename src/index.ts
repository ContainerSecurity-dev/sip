import express from 'express';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.get('/', (_req, res) => {
  res.json({ message: 'Hello from toy Express TypeScript app!' });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
