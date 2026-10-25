const processRunner = require('./processRunner');
const config = require('../config');

module.exports = {
    unzip: function(file, outputDir, cb, noDirectories = false){
        if (config.hasUnzip){
            processRunner.unzip({
                file: file,
                destination: outputDir,
                noDirectories
            }, (err, code, _) => {
                if (err) cb(err);
                else{
                    if (code === 0) cb();
                    else cb(new Error(`Could not extract .zip file, unzip exited with code ${code}`));
                }
            });
        }else if (config.has7z){
            processRunner.sevenUnzip({
                file: file,
                destination: outputDir,
                noDirectories
            }, (err, code, _) => {
                if (err) cb(err);
                else{
                    if (code === 0) cb();
                    else cb(new Error(`Could not extract .zip file, 7z exited with code ${code}`));
                }
            });
        }else{
            cb(new Error("Could not extract .zip file, neither unzip nor 7z is installed"));
        }
    }
}