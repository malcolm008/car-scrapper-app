// server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

// Proxy endpoint to scrape makes
app.get('/api/makes', async (req, res) => {
  try {
    const { data } = await axios.get('https://umvvs.tra.go.tz');
    const $ = cheerio.load(data);
    
    const makes = [];
    $('#makeSelect option').each((i, el) => {
      const value = $(el).attr('value');
      if (value) {
        makes.push({
          value: value,
          text: $(el).text().trim()
        });
      }
    });
    
    res.json(makes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Proxy endpoint to scrape models for a make
app.get('/api/models/:make', async (req, res) => {
  try {
    const { data } = await axios.post('https://umvvs.tra.go.tz/getModels', {
      make: req.params.make
    });
    
    res.json(data); // Assuming the response is already in JSON format
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Proxy endpoint to scrape engine capacities for a model
app.get('/api/engines/:make/:model', async (req, res) => {
  try {
    const { data } = await axios.post('https://umvvs.tra.go.tz/getEngines', {
      make: req.params.make,
      model: req.params.model
    });
    
    res.json(data); // Assuming the response is already in JSON format
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => console.log('Proxy server running on port 3000'));