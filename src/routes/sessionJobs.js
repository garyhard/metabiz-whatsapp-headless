/**
 * Async session job routes
 */

import express from 'express';
import { getSessionFlowJob, serializeSessionFlowJob } from '../services/sessionFlowQueue.js';

const router = express.Router();

/**
 * GET /api/session-jobs/:jobId
 * Get async session-flow job status
 */
router.get('/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const job = getSessionFlowJob(jobId);
  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'Job not found',
      errorCode: 'job_not_found',
    });
  }

  return res.json({
    ok: true,
    job: serializeSessionFlowJob(job),
  });
});

export default router;
