const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { parseStringPromise } = require('xml2js');
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });
    
    const $ = cheerio.load(data);
    return {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || 'CA0B0334', // Default if not found
      eventValidation: $('input#__EVENTVALIDATION').val(),
      makes: $('#MainContent_ddlMake option').map((i, el) => ({
        value: $(el).attr('value'),
        text: $(el).text().trim()
      })).get().filter(opt => opt.value !== '0'),
      scriptManager: $('input#ctl00_ScriptManager1_HiddenField').val() || ''
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
    // Always get fresh page state - don't use cache
    const pageState = await getPageState();
    
    res.json({
      success: true,
      data: {
        makes: pageState.makes,
        tokens: {
          viewState: pageState.viewState,
          viewStateGenerator: pageState.viewStateGenerator,
          eventValidation: pageState.eventValidation
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

    // First get a fresh page state to ensure valid tokens
    const freshState = await getPageState();
    
    const payload = new URLSearchParams();
    payload.append('ctl00$ScriptManager1', 'ctl00$MainContent$UpdatePanel1|ctl00$MainContent$ddlMake');
    payload.append('__EVENTTARGET', 'ctl00$MainContent$ddlMake');
    payload.append('__EVENTARGUMENT', '');
    payload.append('__LASTFOCUS', '');
    payload.append('__VIEWSTATE', freshState.viewState); // Use fresh ViewState
    payload.append('__VIEWSTATEGENERATOR', freshState.viewStateGenerator || 'CA0B0334');
    payload.append('__EVENTVALIDATION', freshState.eventValidation);
    payload.append('__ASYNCPOST', 'true');
    payload.append('ctl00$MainContent$ddlMake', makeId);
    // Include all other required fields with default values
    payload.append('ctl00$MainContent$ddlModel', '0');
    payload.append('ctl00$MainContent$ddlYear', '0');
    payload.append('ctl00$MainContent$ddlCountry', '0');
    payload.append('ctl00$MainContent$ddlFuel', '0');
    payload.append('ctl00$MainContent$ddlEngine', '0');

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Origin': 'https://umvvs.tra.go.tz',
      'Referer': 'https://umvvs.tra.go.tz/',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest'
    };

    // Add delay to mimic human behavior
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const { data } = await axios.post('https://umvvs.tra.go.tz', payload.toString(), { 
      headers,
      maxRedirects: 0
    });

    // Parse the response
    const $ = cheerio.load(data);
    const models = $('#MainContent_ddlModel option').map((i, el) => ({
      value: $(el).attr('value'),
      text: $(el).text().trim()
    })).get().filter(opt => opt.value !== '0');

    if (models.length === 0) {
      throw new Error('No models found in the dropdown after selection');
    }

    // Get fresh tokens from the response
    const newTokens = {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || 'CA0B0334',
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
    console.error('Full error:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data,
      config: error.config
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to fetch models',
      details: error.message,
      debug: process.env.NODE_ENV === 'development' ? {
        stack: error.stack
      } : undefined
    });
  }
});

// Get years for a specific model
app.post('/api/dropdown', async (req, res) => {
  try {
    const { type, parentId, tokens } = req.body;
    
    if (!type || !parentId || !tokens) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters (type, parentId, tokens)'
      });
    }

    // Validate type
    const validTypes = ['years', 'countries', 'fuel-types', 'engines'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type. Must be one of: ${validTypes.join(', ')}`
      });
    }

    // Map type to ASP.NET control IDs
    const controlMap = {
      'years': {
        control: 'ddlYear',
        target: 'ddlModel',
        parentControl: 'ddlModel'
      },
      'countries': {
        control: 'ddlCountry',
        target: 'ddlYear',
        parentControl: 'ddlYear'
      },
      'fuel-types': {
        control: 'ddlFuel',
        target: 'ddlCountry',
        parentControl: 'ddlCountry'
      },
      'engines': {
        control: 'ddlEngine',
        target: 'ddlFuel',
        parentControl: 'ddlFuel'
      }
    };

    const config = controlMap[type];
    const payload = new URLSearchParams();
    
    // Build the ASP.NET payload
    payload.append(`ctl00$MainContent$${config.parentControl}`, parentId);
    payload.append('__EVENTTARGET', `ctl00$MainContent$${config.target}`);
    payload.append('__EVENTARGUMENT', '');
    payload.append('__LASTFOCUS', '');
    payload.append('__VIEWSTATE', tokens.viewState);
    payload.append('__VIEWSTATEGENERATOR', tokens.viewStateGenerator || 'CA0B0334');
    payload.append('__EVENTVALIDATION', tokens.eventValidation);
    payload.append('__ASYNCPOST', 'true');
    payload.append('ctl00$ScriptManager1', `ctl00$MainContent$UpdatePanel1|ctl00$MainContent$${config.target}`);

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'https://umvvs.tra.go.tz',
      'Referer': 'https://umvvs.tra.go.tz/',
      'X-MicrosoftAjax': 'Delta=true',
      'X-Requested-With': 'XMLHttpRequest'
    };

    // Add delay to mimic human interaction
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const { data } = await axios.post('https://umvvs.tra.go.tz', payload.toString(), { 
      headers,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });

    // Parse the response
    let items = [];
    let newTokens = {
      viewState: tokens.viewState,
      viewStateGenerator: tokens.viewStateGenerator,
      eventValidation: tokens.eventValidation
    };

    // Try to parse as ASP.NET AJAX response
    const parts = data.split('|');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'updatePanel' && parts[i+1] === 'MainContent_ddlPanel') {
        const html = parts[i+2];
        const $ = cheerio.load(html);
        
        // Extract items
        $(`select[id="MainContent_${config.control}"] option`).each((i, el) => {
          const value = $(el).attr('value');
          if (value && value !== '0') {
            items.push({
              value: value,
              text: $(el).text().trim()
            });
          }
        });

        // Extract new tokens
        newTokens.viewState = $('input#__VIEWSTATE').val() || newTokens.viewState;
        newTokens.eventValidation = $('input#__EVENTVALIDATION').val() || newTokens.eventValidation;
        break;
      }
    }

    // Fallback to full HTML parsing if AJAX parsing failed
    if (items.length === 0) {
      const $ = cheerio.load(data);
      $(`#MainContent_${config.control} option`).each((i, el) => {
        const value = $(el).attr('value');
        if (value && value !== '0') {
          items.push({
            value: value,
            text: $(el).text().trim()
          });
        }
      });
      
      // Update tokens from full page
      newTokens.viewState = $('input#__VIEWSTATE').val() || newTokens.viewState;
      newTokens.eventValidation = $('input#__EVENTVALIDATION').val() || newTokens.eventValidation;
    }

    if (items.length === 0) {
      console.warn(`No ${type} found in response.`, data);
    }

    res.json({
      success: true,
      data: {
        [type]: items,
        tokens: newTokens
      }
    });

  } catch (error) {
    console.error(`${type} fetch error:`, error.message);
    res.status(500).json({
      success: false,
      error: `Failed to fetch ${type}`,
      details: error.message,
      response: error.response?.data
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