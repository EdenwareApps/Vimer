const FIX_FORBIDS = `
STRICT RULES:
- Do not change original file names.
- Do not use the concat protocol (concat:file1|file2) or concat demuxer (-f concat), instead use the concat video filter (-filter_complex) if needed.
- Do not using command piping.
- Do not insert placeholders.
- Dot not use /dev/null
- When using -loop set -t too, to prevent infinite looping.
- Do not map same filter output label twice in a command.
- Reduce the CPU usage of the commands whenever possible.
`

const FORBIDS = `
STRICT RULES:
- Do not change original file names.
- Do not use the concat protocol (concat:file1|file2) or concat demuxer (-f concat), instead use the concat video filter (-filter_complex) if needed.
- Do not using command piping.
- Do not insert placeholders.
- Dot not use /dev/null
- When using -loop set -t too, to prevent infinite looping.
- Do not map same filter output label twice in a command.
- Use only ffmpeg commands, do not use shell commands like 'mv' or 'rm'.
- Skip redundant or unnecessary re-encoding. Use 'copy' codec whenever applicable.
- Reduce the CPU usage of the commands whenever possible.
`

const JSON_OUTPUT_INSTRUCT = `Print a JSON object with results in following schema:
{
    "commands": [],
    "tempFiles": [],
    "outputFiles": []
}
'commands' is a array of the required FFmpeg commands as strings.
'tempFiles' is the array of files generated in the commands that can be deleted after executing all the commands.
'outputFiles' is the array of files generated in the commands that should not be deleted, as it contains the goal output files.
`

const JSON_FIX_OUTPUT_INSTRUCT = `Print a JSON object with result in following schema:
{
    "commands": []
}
'commands' is a array with one string value, which is the fixed command.
'tempFiles' is a empty array.
'outputFiles' is a empty array.
`

const DESCRIBE_TASK_INSTRUCT = `Briefly define in a '{1}' language text, in a list, without introduction paragraph in the response, what will be done with the media file on each of the following commands:
'{0}'`


const FFMPEG_INSTRUCT = `Which FFmpeg commands are necessary to perfectly achieve this goal:
Goal: \`{0}\`.
Files available: {1}.
Output files should have most appropriated output format extension.
${FORBIDS}
${JSON_OUTPUT_INSTRUCT}`


const FFMPEG_IMPROVE_INSTRUCT = `Consider the following chain of commands:
\`{0}\`
Taking attention to the following goal:
\`{1}\`
Then do these tasks:
- Analyze the commands for syntax errors.
- Compare the desired end results of the goal to the command probable effects, looking for possible flaws in using this command to achieve this goal, predicting what could go different from the desired result.
- If flaws are found, find solutions to address it.
${FORBIDS}
${JSON_OUTPUT_INSTRUCT.replace('with results', 'with improved results')}`


const FFMPEG_IMPROVE_PROMPT = `Answer without an introduction paragraph or explanation. Consider following 'goal':
\`{0}\`
The provided files are: {1}
Imagine the desired end result on the 'goal' and improve this 'goal' text by making it more detailed to prevent if from being misunderstood.`


const FFMPEG_FIX_INSTRUCT = `
Fix the following FFmpeg command syntax or strategy.
Command: \`{0}\`
Error output: \`{1}\`
Generate a fixed version of this single command to prevent the error present on output.
Keep the same output file name.
Keep the same functionality.
${FIX_FORBIDS}
${JSON_FIX_OUTPUT_INSTRUCT}
`

module.exports = {
    DESCRIBE_TASK_INSTRUCT,
    FFMPEG_FIX_INSTRUCT,
    FFMPEG_IMPROVE_INSTRUCT,
    FFMPEG_IMPROVE_PROMPT,
    FFMPEG_INSTRUCT,
    FORBIDS,
    JSON_OUTPUT_INSTRUCT
}