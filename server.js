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
    const { data } = await axios.get('https://umvvs.tra.go.tz');const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const URL = require('url').URL;

const app = express();
app.use(cors());
app.use(express.json());

// Cache for VIEWSTATE and other tokens (valid for 5 minutes)
const cache = {
  data: null,
  timestamp: 0,
  get isValid() {
    return this.data && Date.now() - this.timestamp < 300000; // 5 minutes
  }
};

// Helper function to get fresh page state
async function getPageState() {
  try {
    const { data } = await axios.get('https://umvvs.tra.go.tz', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(data);
    return {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val(),
      eventValidation: $('input#__EVENTVALIDATION').val(),
      makes: $('#MainContent_ddlMake option').map((i, el) => ({
        value: $(el).attr('value'),
        text: $(el).text().trim()
      })).get().filter(opt => opt.value !== '0')
    };
  } catch (error) {
    console.error('Failed to get page state:', error.message);
    throw error;
  }
}

// Initialize or refresh cache
async function refreshCache() {
  try {
    cache.data = await getPageState();
    cache.timestamp = Date.now();
    console.log('Cache refreshed at', new Date().toISOString());
  } catch (error) {
    console.error('Cache refresh failed:', error.message);
  }
}

// Initial cache refresh
refreshCache();
// Refresh cache every 5 minutes
setInterval(refreshCache, 300000);

// API Endpoints

// Get initialization data (makes + tokens)
app.get('/api/init', async (req, res) => {
  try {
    if (!cache.isValid) {
      await refreshCache();
    }
    
    res.json({
      success: true,
      data: {
        makes: cache.data.makes,
        tokens: {
          viewState: cache.data.viewState,
          viewStateGenerator: cache.data.viewStateGenerator,
          eventValidation: cache.data.eventValidation
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to initialize',
      details: error.message
    });
  }
});

// Get models for a specific make
app.post('/api/models', async (req, res) => {
  try {
    const { makeId, tokens } = req.body;
    
    if (!makeId || !tokens) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const payload = new URLSearchParams();
    payload.append('ctl00$MainContent$ddlMake', makeId);
    payload.append('__EVENTTARGET', 'ctl00$MainContent$ddlMake');
    payload.append('__EVENTARGUMENT', '');
    payload.append('__LASTFOCUS', '');
    payload.append('__VIEWSTATE', tokens.viewState);
    payload.append('__VIEWSTATEGENERATOR', tokens.viewStateGenerator || 'CA0B0334');
    payload.append('__EVENTVALIDATION', tokens.eventValidation);
    payload.append('__ASYNCPOST', 'true');

    const { data } = await axios.post('https://umvvs.tra.go.tz', payload.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://umvvs.tra.go.tz',
        'Referer': 'https://umvvs.tra.go.tz/'
      }
    });

    // Parse the response
    const models = [];
    const modelRegex = /<option value="(\d+)">([^<]+)<\/option>/g;
    let match;
    
    while ((match = modelRegex.exec(data)) !== null) {
      if (match[1] !== '0') {
        models.push({
          value: match[1],
          text: match[2].trim()
        });
      }
    }

    // Extract new tokens for subsequent requests
    const $ = cheerio.load(data);
    const newTokens = {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val(),
      eventValidation: $('input#__EVENTVALIDATION').val()
    };

    res.json({
      success: true,
      data: {
        models,
        tokens: newTokens
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch models',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    cacheAge: cache.isValid ? Math.floor((Date.now() - cache.timestamp) / 1000) + 's' : 'expired'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API endpoints:`);
  console.log(`- GET   /api/init`);
  console.log(`- POST  /api/models`);
  console.log(`- GET   /api/health`);
});
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