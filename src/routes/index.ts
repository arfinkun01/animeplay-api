import { Router, type IRouter } from "express";
import healthRouter from "./health";
import animeRouter from "./anime";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(animeRouter);
router.use(adminRouter);

export default router;
