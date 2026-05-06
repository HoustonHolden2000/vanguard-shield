// middleware/validate.js
// Joi schema validators for request bodies.

const Joi = require('joi');

function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      return res.status(400).json({
        error: 'validation_failed',
        details: error.details.map(d => ({ path: d.path.join('.'), message: d.message }))
      });
    }
    req.body = value;
    next();
  };
}

const loginSchema = Joi.object({
  username: Joi.string().min(3).max(64).required(),
  password: Joi.string().min(1).max(256).required()
});

const refreshSchema = Joi.object({
  refresh_token: Joi.string().required()
});

const scanSchema = Joi.object({
  site_id: Joi.string().min(1).max(64).required(),
  scan_type: Joi.string().valid('driver_license', 'bill_of_lading', 'bill_of_lading_manual').required(),
  payload: Joi.string().min(1).max(8192).required(),
  identifier_short: Joi.string().max(64).allow('', null),
  gps_lat: Joi.number().min(-90).max(90).allow(null),
  gps_lon: Joi.number().min(-180).max(180).allow(null),
  photo_b64: Joi.string().max(5 * 1024 * 1024).allow('', null), // up to 5MB photo
  metadata: Joi.object().unknown(true).allow(null)
});

module.exports = { validateBody, loginSchema, refreshSchema, scanSchema };
