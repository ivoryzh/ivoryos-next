async function fetchAll() {
  const data = { instruments: {}, instrument_meta: {} };
  
  // mock fetching workflows
  const workflows = ["test", "math"];
  data.instruments["Workflows"] = {};
  
  for (const wf of workflows) {
     // mock fetching workflow JSON
     const wfData = {
         prep: [],
         script: [
             { args: { rate: "#rate_val" } },
             { args: { delay: 10 } }
         ],
         cleanup: []
     };
     
     const dynamicParams = {};
     const scanBlocks = (blocks) => {
         blocks.forEach(b => {
             if (b.args) {
                 Object.values(b.args).forEach(val => {
                     if (typeof val === 'string' && val.startsWith('#')) {
                         const paramName = val.substring(1);
                         dynamicParams[paramName] = { type: 'string', required: true };
                     }
                 });
             }
         });
     };
     scanBlocks(wfData.prep || []);
     scanBlocks(wfData.script || []);
     scanBlocks(wfData.cleanup || []);
     
     data.instruments["Workflows"][wf] = {
         description: "Library Workflow",
         parameters: dynamicParams,
         return_type: "None"
     };
  }
  console.log(JSON.stringify(data.instruments.Workflows, null, 2));
}
fetchAll();
