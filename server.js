const express = require('express');
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

    // 1. Prepare the exact payload structure
    const payload = new URLSearchParams();
    payload.append('ctl00$ctl08', '');
    payload.append('ctl00$MainContent$ddlPanel', 'ctl00$MainContent$ddlModel');
    payload.append('ctl00$MainContent$ddlMake', makeId);
    payload.append('ctl00$MainContent$ddlModel', '0');
    payload.append('ctl00$MainContent$ddlYear', '0');
    payload.append('ctl00$MainContent$ddlCountry', '0');
    payload.append('ctl00$MainContent$ddlFuel', '0');
    payload.append('ctl00$MainContent$ddlEngine', '0');
    payload.append('__EVENTTARGET', 'ctl00$MainContent$ddlMake');
    payload.append('__EVENTARGUMENT', '');
    payload.append('__LASTFOCUS', '');
    payload.append('__VIEWSTATE', tokens.viewState);
    payload.append('__VIEWSTATEGENERATOR', tokens.viewStateGenerator || 'CA0B0334');
    payload.append('__EVENTVALIDATION', tokens.eventValidation);
    payload.append('__ASYNCPOST', 'true');

    // 2. Add delay and custom headers
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const { data } = await axios.post('https://umvvs.tra.go.tz', payload.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://umvvs.tra.go.tz',
        'Referer': 'https://umvvs.tra.go.tz/',
        'X-MicrosoftAjax': 'Delta=true',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 10000 // 10 second timeout
    });

    // 3. DEBUG: Log the raw response snippet
    console.log("Response snippet:", data.substring(0, 500));

    // 4. Enhanced parsing with multiple fallbacks
    const models = [];
    const $ = cheerio.load(data);
    
    // Try direct select first
    $('#MainContent_ddlModel option').each((i, el) => {
      const value = $(el).attr('value');
      if (value && value !== '0') {
        models.push({
          value: value,
          text: $(el).text().replace(/&amp;/g, '&').trim()
        });
      }
    });

    // If empty, try parsing the updatePanel content
    if (models.length === 0) {
      const updatePanelContent = data.match(/updatePanel\|[^|]+\|([^|]+)\|/)?.[1];
      if (updatePanelContent) {
        const $update = cheerio.load(updatePanelContent);
        $update('option').each((i, el) => {
          const value = $update(el).attr('value');
          if (value && value !== '0') {
            models.push({
              value: value,
              text: $update(el).text().replace(/&amp;/g, '&').trim()
            });
          }
        });
      }
    }

    // If still empty, try regex as last resort
    if (models.length === 0) {
      const modelRegex = /<option\s+value="([^"]+)"[^>]*>(.*?)<\/option>/gis;
      let match;
      while ((match = modelRegex.exec(data)) !== null) {
        if (match[1] !== '0') {
          models.push({
            value: match[1],
            text: match[2].replace(/&amp;/g, '&').trim()
          });
        }
      }
    }

    // 5. Extract new tokens with fallbacks
    const newTokens = {
      viewState: $('input#__VIEWSTATE').val() || tokens.viewState,
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || tokens.viewStateGenerator,
      eventValidation: $('input#__EVENTVALIDATION').val() || tokens.eventValidation
    };

    if (models.length === 0) {
      console.error("No models found in response. Full response:", data);
      return res.status(500).json({
        success: false,
        error: 'No models found in response',
        debug: 'Check server logs for response details'
      });
    }

    res.json({
      success: true,
      data: {
        models,
        tokens: newTokens
      }
    });

  } catch (error) {
    console.error('Model fetch error:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    res.status(500).json({
      success: false,
      error: 'Failed to fetch models',
      details: error.message
    });
  }
});


// Get years for a specific model
app.post('/api/years', async (req, res) => {
  try {
    const { modelId, tokens } = req.body;
    
    if (!modelId || !tokens) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const payload = new URLSearchParams();
    payload.append('ctl00$MainContent$ddlModel', modelId);
    payload.append('__EVENTTARGET', 'ctl00$MainContent$ddlModel');
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

    // Parse years
    const years = [];
    const yearRegex = /<option value="(\d+)">([^<]+)<\/option>/g;
    let match;
    
    while ((match = yearRegex.exec(data)) !== null) {
      if (match[1] !== '0') {
        years.push({
          value: match[1],
          text: match[2].trim()
        });
      }
    }

    // Extract new tokens
    const $ = cheerio.load(data);
    const newTokens = {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val(),
      eventValidation: $('input#__EVENTVALIDATION').val()
    };

    res.json({
      success: true,
      data: {
        years,
        tokens: newTokens
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch years',
      details: error.message
    });
  }
});

// Get countries for a specific year
app.post('/api/countries', async (req, res) => {
  try {
    const { yearId, tokens } = req.body;
    
    if (!yearId || !tokens) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const payload = new URLSearchParams();
    payload.append('ctl00$MainContent$ddlYear', yearId);
    payload.append('__EVENTTARGET', 'ctl00$MainContent$ddlYear');
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

    // Parse countries
    const countries = [];
    const countryRegex = /<option value="(\d+)">([^<]+)<\/option>/g;
    let match;
    
    while ((match = countryRegex.exec(data)) !== null) {
      if (match[1] !== '0') {
        countries.push({
          value: match[1],
          text: match[2].trim()
        });
      }
    }

    // Extract new tokens
    const $ = cheerio.load(data);
    const newTokens = {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val(),
      eventValidation: $('input#__EVENTVALIDATION').val()
    };

    res.json({
      success: true,
      data: {
        countries,
        tokens: newTokens
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch countries',
      details: error.message
    });
  }
});

// Get fuel types for a specific country
app.post('/api/fuel-types', async (req, res) => {
  try {
    const { countryId, tokens } = req.body;
    
    if (!countryId || !tokens) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const payload = new URLSearchParams();
    payload.append('ctl00$MainContent$ddlCountry', countryId);
    payload.append('__EVENTTARGET', 'ctl00$MainContent$ddlCountry');
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

    // Parse fuel types
    const fuelTypes = [];
    const fuelRegex = /<option value="(\d+)">([^<]+)<\/option>/g;
    let match;
    
    while ((match = fuelRegex.exec(data)) !== null) {
      if (match[1] !== '0') {
        fuelTypes.push({
          value: match[1],
          text: match[2].trim()
        });
      }
    }

    // Extract new tokens
    const $ = cheerio.load(data);
    const newTokens = {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val(),
      eventValidation: $('input#__EVENTVALIDATION').val()
    };

    res.json({
      success: true,
      data: {
        fuelTypes,
        tokens: newTokens
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch fuel types',
      details: error.message
    });
  }
});

// Get engines for a specific fuel type
app.post('/api/engines', async (req, res) => {
  try {
    const { fuelTypeId, tokens } = req.body;
    
    if (!fuelTypeId || !tokens) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    const payload = new URLSearchParams();
    payload.append('ctl00$MainContent$ddlFuel', fuelTypeId);
    payload.append('__EVENTTARGET', 'ctl00$MainContent$ddlFuel');
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

    // Parse engines
    const engines = [];
    const engineRegex = /<option value="(\d+)">([^<]+)<\/option>/g;
    let match;
    
    while ((match = engineRegex.exec(data)) !== null) {
      if (match[1] !== '0') {
        engines.push({
          value: match[1],
          text: match[2].trim()
        });
      }
    }

    // Extract new tokens
    const $ = cheerio.load(data);
    const newTokens = {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val(),
      eventValidation: $('input#__EVENTVALIDATION').val()
    };

    res.json({
      success: true,
      data: {
        engines,
        tokens: newTokens
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch engines',
      details: error.message
    });
  }
});

// [Rest of your existing code remains the same]

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
  console.log(`- GET    /api/init`);
  console.log(`- POST   /api/models`);
  console.log(`- POST   /api/years`);
  console.log(`- POST   /api/countries`);
  console.log(`- POST   /api/fuel-types`);
  console.log(`- POST   /api/engines`);
  console.log(`- GET    /api/health`);
});