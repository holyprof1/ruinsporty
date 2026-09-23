// cPanel/Passenger entrypoint. Passenger already supervises the process;
// spawning another Node runtime wastes an NPROC slot and duplicates threads.
'use strict';
require('./server');
