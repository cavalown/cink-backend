
import moviesShelf from '@modules/moviesshelf/moviesshelf.routes';
import { Router } from 'express';
import AdminUserRouter from './modules/adminauth/adminauth.routes';

import UserRouter from '@modules/user/user.routes';
import adminMember from '@modules/adminmember/adminmember.routes';
import adminMovies from "@modules/adminmovies/adminmovies.routes";

import SessionsRouter from '@modules/sessions/sessions.routes';
import TheatersRouter from '@modules/theaters/theaters.routes';
const router = Router()

//importing all routes here
router.get('/', (req, res) => {
    return res.json({ Server: 'on' });
});
router.use('/admin/moviesShelf', moviesShelf)
router.use('/user', UserRouter);
router.use('/admin/user', AdminUserRouter);
router.use("/admin/member", adminMember);
router.use("/admin/movies", adminMovies);
router.use('/sessions', SessionsRouter);
router.use('/theaters', TheatersRouter);


export default router
